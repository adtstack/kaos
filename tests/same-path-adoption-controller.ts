import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import {
	EditorAuthorityAdmissionRegistry,
} from "../src/runtime/editorAuthorityAdmission";
import {
	ReconciliationController,
	type ExternalDiskMutationProbeTicket,
	type StableMarkdownReadResult,
} from "../src/runtime/reconciliationController";
import { EditorBindingManager } from "../src/sync/editorBinding";
import type {
	OpenEditorMutationTicket,
	OpenEditorMutationViewTicket,
} from "../src/sync/editorBinding";
import type {
	EditorAuthorityLease,
	PathEditorAuthority,
} from "../src/sync/pathEditorAuthority";
import type {
	SamePathAdoptionBindContext,
	SamePathAdoptionMutationContext,
	SamePathAdoptionPostMutationProof,
	SamePathAdoptionProposal,
	SamePathAdoptionRequest,
	SamePathAdoptionSeedContext,
} from "../src/sync/samePathAdoption";
import type { VaultSync } from "../src/sync/vaultSync";

type MutableFile = TFile & {
	path: string;
	stat: { ctime: number; mtime: number; size: number };
};

type MutableView = MarkdownView & {
	file: TFile | null;
	leaf: { id: string };
	editor: { getValue(): string };
};

function file(path: string, content: string, nonce = 1): MutableFile {
	return Object.assign(new TFile(), {
		path,
		stat: { ctime: nonce, mtime: nonce, size: content.length },
	}) as MutableFile;
}

type Fixture = ReturnType<typeof makeFixture>;

interface ControllerFixtureOptions {
	remoteMissing?: boolean;
	remoteText?: string;
	localText?: string;
	diskText?: string;
	baselineAvailable?: boolean;
	failArtifactCreate?: boolean;
	artifactReadMismatch?: boolean;
	staleAfterArtifactCreate?: boolean;
	advanceProviderBeforeDiskFlush?: boolean;
	rejectBoundSettlementCurrent?: boolean;
	frontmatterBlocked?: boolean;
	pauseArtifactCreate?: boolean;
}

function makeFixture(input: boolean | ControllerFixtureOptions = false): {
	controller: ReconciliationController;
	request(): SamePathAdoptionRequest;
	plan(): Promise<SamePathAdoptionProposal>;
	mutationContext(proposal: SamePathAdoptionProposal): SamePathAdoptionMutationContext;
	bindContext(proposal: SamePathAdoptionProposal): SamePathAdoptionBindContext;
	settleForBind(proposal: SamePathAdoptionProposal): SamePathAdoptionBindContext;
	mutateLocal(): void;
	mutateSelection(): void;
	startComposition(): void;
	mutateProvider(): void;
	replaceFile(): void;
	advanceGeneration(): void;
	advanceHostSave(): void;
	addPane(content?: string): void;
	remoteText(): string;
	seedCalls(): readonly string[];
	seededText(): string | null;
	frontmatterCalls(): readonly Readonly<{
		path: string;
		previousContent: string | null;
		nextContent: string;
		reason: string;
	}>[];
	activateProvider(): void;
	currentFile(): MutableFile;
	localText(): string;
	createdArtifacts(): ReadonlyMap<string, string>;
	conflictMergeBases(): ReadonlyMap<string, string>;
	markBound(receipt: import("../src/sync/samePathAdoption").SamePathAdoptionBindReceipt): void;
	diskFlushCalls(): readonly Readonly<{ path: string; force: boolean }>[];
	baselinePublicationCount(): number;
	diskCompletionCount(): number;
	diskInvalidationCount(): number;
	attemptOrdinaryBaselineSettlement(): Promise<boolean>;
	beginExternalProbe(sequence: number): ExternalDiskMutationProbeTicket;
	settleExternalProbe(ticket: ExternalDiskMutationProbeTicket): Promise<boolean>;
	markExternalProbeDisposition(
		ticket: ExternalDiskMutationProbeTicket,
		disposition: "stale" | "unavailable",
	): boolean;
	artifactCreateStarted(): boolean;
	releaseArtifactCreate(): void;
} {
	const options: ControllerFixtureOptions = typeof input === "boolean"
		? { remoteMissing: input }
		: input;
	const remoteMissing = options.remoteMissing === true;
	const path = "Notes/live-adoption.md";
	const base = "# note\nbase\n";
	const baselineHash = "49bf4144db649a2f6168c52ea00e71b0f009ccaea61e0d12a481ed95bd52d552";
	let diskIndexHash: string | null = options.baselineAvailable === false
		? null
		: baselineHash;
	let local = options.localText ?? "# note\nlocal\n";
	let disk = options.diskText ?? (remoteMissing ? base : local);
	const doc = new Y.Doc();
	const remote = doc.getText("remote");
	remote.insert(0, options.remoteText ?? base);
	let activeRemote: Y.Text | null = remoteMissing ? null : remote;
	let activeFileId: string | null = remoteMissing ? null : "file-live";
	const seedCalls: string[] = [];
	const frontmatterCalls: Array<Readonly<{
		path: string;
		previousContent: string | null;
		nextContent: string;
		reason: string;
	}>> = [];
	let currentFile = file(path, disk);
	let generation = 4;
	let editorRevision = 11;
	let editorTransactionSeq = 3;
	let selectionEpoch = 5;
	let compositionEpoch = 2;
	let activeCompositionEpoch: number | null = null;
	let hostSaveEpoch = 7;
	let requestSequence = 0;
	let mintedPostMutationProof: SamePathAdoptionPostMutationProof | null = null;
	let boundReceipt:
		| import("../src/sync/samePathAdoption").SamePathAdoptionBindReceipt
		| null = null;
	let baselinePublicationCount = 0;
	let diskCompletionCount = 0;
	let diskInvalidationCount = 0;
	const diskFlushCalls: Array<Readonly<{ path: string; force: boolean }>> = [];
	const createdArtifacts = new Map<string, { file: MutableFile; content: string }>();
	const conflictMergeBases = new Map<string, string>();
	let artifactCreateCount = 0;
	let artifactCreateStarted = false;
	let releaseArtifactCreate = () => {};
	const artifactCreateGate = options.pauseArtifactCreate
		? new Promise<void>((resolve) => {
			releaseArtifactCreate = resolve;
		})
		: null;
	const cm = {
		state: EditorState.create({ doc: local }),
	} as unknown as EditorView & { state: EditorState };
	const view = Object.assign(new MarkdownView(), {
		file: currentFile,
		leaf: { id: "leaf-live" },
		editor: { getValue: () => local },
	}) as MutableView;
	let openViews: MutableView[] = [view];
	const secondaryPanes: Array<Readonly<{
		view: MutableView;
		cm: EditorView & { state: EditorState };
		content: string;
	}>> = [];
	const lease = Object.freeze({ leaseId: "adoption-editor-lease" }) as EditorAuthorityLease;
	let authority: PathEditorAuthority = Object.freeze({
		kind: "proven-single",
		content: local,
		lease,
	});

	const makeTicket = (): OpenEditorMutationTicket => {
		const snapshot: OpenEditorMutationViewTicket = Object.freeze({
			bootSessionId: "boot-live",
			sessionId: "session-live",
			handoffGeneration: generation,
			displayedFile: currentFile,
			displayedPath: path,
			targetFile: currentFile,
			stableTargetIdentityProven: true,
			switchIntentSeq: null,
			nativeHistoryEpoch: 3,
			selectionEpoch,
			scrollEpoch: 6,
			handoffPresentation: "stable",
			handoffPhase: null,
			intentStateKind: null,
			pendingHostLoadTokenId: null,
			view,
			viewId: "view-live",
			leafId: "leaf-live",
			cm,
			cmId: "cm-live",
			bindingEpoch: 2,
			editorRevision,
			editorAuthorityRevision: editorRevision,
			editorAuthorityContent: local,
			editorDocument: cm.state.doc,
			editorContent: local,
		});
		const secondarySnapshots = secondaryPanes.map((pane, index) => Object.freeze({
			bootSessionId: "boot-live",
			sessionId: `session-secondary-${index}`,
			handoffGeneration: generation,
			displayedFile: currentFile,
			displayedPath: path,
			targetFile: currentFile,
			stableTargetIdentityProven: true,
			switchIntentSeq: null,
			nativeHistoryEpoch: 3,
			selectionEpoch: 5,
			scrollEpoch: 6,
			handoffPresentation: "stable" as const,
			handoffPhase: null,
			intentStateKind: null,
			pendingHostLoadTokenId: null,
			view: pane.view,
			viewId: `view-secondary-${index}`,
			leafId: pane.view.leaf.id,
			cm: pane.cm,
			cmId: `cm-secondary-${index}`,
			bindingEpoch: 0,
			editorRevision: 0,
			editorAuthorityRevision: 0,
			editorAuthorityContent: pane.content,
			editorDocument: pane.cm.state.doc,
			editorContent: pane.content,
		}) satisfies OpenEditorMutationViewTicket);
		return Object.freeze({
			path,
			views: Object.freeze([snapshot, ...secondarySnapshots]),
		});
	};
	let currentTicket = makeTicket();

	const request = (): SamePathAdoptionRequest => Object.freeze({
		requestId: `adoption-request-${++requestSequence}`,
		adoptionId: "adoption-live",
		sessionId: "session-live",
		leafId: "leaf-live",
		generation,
		path,
		file: currentFile,
		fileId: activeFileId,
		ytext: activeRemote,
		openEditorTicket: currentTicket,
		editorAuthority: authority,
		hostCapability: "owned-scheduler-with-unload-flush",
		hostSaveEpoch,
		cm,
		startDocument: cm.state.doc,
		editorRevision,
		editorTransactionSeq,
		bindingEpoch: 2,
		nativeHistoryEpoch: 3,
		inputEpoch: 4,
		compositionEpoch,
		activeCompositionEpoch,
		selectionEpoch,
		scrollEpoch: 6,
	});

	const vaultSync = {
		ydoc: doc,
		provider: { awareness: {} },
		getActiveFileIdsForPath: (candidate: string) =>
			candidate === path && activeFileId !== null ? [activeFileId] : [],
		getTextForPath: (candidate: string) => candidate === path ? activeRemote : null,
		getFileId: (candidate: string) =>
			candidate === path ? activeFileId ?? undefined : undefined,
		getFileIdForText: (candidate: Y.Text) =>
			candidate === activeRemote ? activeFileId ?? undefined : undefined,
		ensureFile: (
			candidate: string,
			content: string,
			_device: string,
			options: { canCreate?: () => boolean },
		) => {
			seedCalls.push(content);
			if (candidate !== path) return { kind: "blocked" as const, reason: "policy" as const };
			if (activeRemote !== null && activeFileId !== null) {
				return { kind: "existing" as const, fileId: activeFileId, ytext: activeRemote };
			}
			if (options.canCreate && !options.canCreate()) {
				return { kind: "blocked" as const, reason: "policy" as const };
			}
			activeRemote = doc.getText("seeded-remote");
			activeRemote.insert(0, content);
			activeFileId = "seeded-file-live";
			return { kind: "created" as const, fileId: activeFileId, ytext: activeRemote };
		},
		isMarkdownTombstoned: () => false,
		isPendingRenameTarget: () => false,
	} as unknown as VaultSync;

	const editorBindings = {
		captureOpenEditorMutationTicket: () => currentTicket,
		validateOpenEditorMutationTicket: (
			candidate: OpenEditorMutationTicket,
			views: readonly MarkdownView[],
		) => candidate === currentTicket && views.length === openViews.length
			? { current: true as const }
			: { current: false as const, reason: "view-set-changed" as const },
		capturePathEditorAuthority: () => authority,
		isPathEditorAuthorityLeaseCurrent: (candidate: EditorAuthorityLease) =>
			candidate === lease && authority.kind === "proven-single",
		isSamePathAdoptionRequestCurrent: (candidate: SamePathAdoptionRequest) =>
			candidate.sessionId === "session-live"
			&& candidate.generation === generation
			&& candidate.file === currentFile
			&& candidate.file.path === path
			&& candidate.cm === cm
			&& candidate.startDocument === cm.state.doc
			&& candidate.editorRevision === editorRevision
			&& candidate.editorTransactionSeq === editorTransactionSeq
			&& candidate.hostSaveEpoch === hostSaveEpoch
			&& candidate.selectionEpoch === selectionEpoch
			&& candidate.compositionEpoch === compositionEpoch
			&& candidate.activeCompositionEpoch === activeCompositionEpoch
			&& candidate.openEditorTicket === currentTicket
			&& candidate.editorAuthority === authority
			&& openViews.length === currentTicket.views.length,
		isSamePathAdoptionBindContextCurrent: (context: SamePathAdoptionBindContext) =>
			context.postMutation === mintedPostMutationProof,
		isSamePathAdoptionDiskSettlementCurrent: (receipt: unknown) =>
			receipt === boundReceipt && options.rejectBoundSettlementCurrent !== true,
		isSamePathAdoptionProjectionHeld: () => boundReceipt !== null,
		completeSamePathAdoptionDiskSettlement: (receipt: unknown, content: string) => {
			if (receipt !== boundReceipt || content !== boundReceipt.targetText) return false;
			diskCompletionCount += 1;
			boundReceipt = null;
			return true;
		},
		invalidateSamePathAdoptionDiskSettlement: (receipt: unknown) => {
			if (receipt !== boundReceipt) return false;
			diskInvalidationCount += 1;
			boundReceipt = null;
			return true;
		},
		getLastEditorActivityForPath: () => null,
		isBound: () => boundReceipt !== null,
	};
	let controller!: ReconciliationController;
	const diskMirror = {
		isPreservedUnresolved: () => false,
		getPreservedUnresolvedEntries: () => [],
		suppressLocalCreate: async () => null,
		rollbackLocalCreateSuppression: () => {},
		flushWrite: async (
			candidate: string,
			force: boolean,
			runtimeOptions: {
				isAuthorityCurrent?: () => boolean;
				isSamePathAdoptionSettlementCurrent?: () => boolean;
			},
		) => {
			diskFlushCalls.push(Object.freeze({ path: candidate, force }));
			if (options.advanceProviderBeforeDiskFlush) {
				doc.transact(() => remote.insert(remote.length, "provider-before-flush"));
			}
			if (
				runtimeOptions.isAuthorityCurrent?.() !== true
				|| runtimeOptions.isSamePathAdoptionSettlementCurrent?.() !== true
			) {
				return { kind: "deferred" as const, path: candidate, reason: "authority-stale" as const };
			}
			const content = boundReceipt?.targetText ?? "";
			const admission = controller.captureDiskBaselineSettlementAdmission(
				candidate,
				"settled-content-hash",
				content,
			);
			if (!admission) {
				return { kind: "deferred" as const, path: candidate, reason: "authority-stale" as const };
			}
			baselinePublicationCount += 1;
			diskIndexHash = "settled-content-hash";
			if (!controller.commitDiskBaselineSettlementAdmission(admission)) {
				return { kind: "deferred" as const, path: candidate, reason: "authority-stale" as const };
			}
			return {
				kind: "unchanged" as const,
				path: candidate,
				content,
				contentHash: "settled-content-hash",
			};
		},
	};

	const app = {
		vault: {
			getAbstractFileByPath: (candidate: string) => candidate === path
				? currentFile
				: createdArtifacts.get(candidate)?.file ?? null,
			getFiles: () => Array.from(createdArtifacts.values(), (entry) => entry.file),
			getMarkdownFiles: () => Array.from(createdArtifacts.values(), (entry) => entry.file),
			read: async () => disk,
			create: async (candidate: string, content: string) => {
				if (artifactCreateGate) {
					artifactCreateStarted = true;
					await artifactCreateGate;
				}
				if (options.failArtifactCreate) {
					throw new Error("private-note-body: injected artifact create failure");
				}
				if (createdArtifacts.has(candidate)) throw new Error("artifact already exists");
				const artifact = file(candidate, content, 100 + artifactCreateCount);
				artifactCreateCount += 1;
				createdArtifacts.set(candidate, { file: artifact, content });
				if (options.staleAfterArtifactCreate && artifactCreateCount === 1) {
					doc.transact(() => remote.insert(remote.length, "provider-advanced"));
				}
				return artifact;
			},
			adapter: {
				stat: async () => ({ mtime: currentFile.stat.mtime, size: currentFile.stat.size }),
				read: async (candidate: string) => {
					const artifact = createdArtifacts.get(candidate);
					if (!artifact) return disk;
					return options.artifactReadMismatch
						? `${artifact.content}mismatch`
						: artifact.content;
				},
			},
		},
		workspace: {
			activeLeaf: { view },
			getActiveViewOfType: () => openViews[0] ?? null,
			iterateAllLeaves: (callback: (leaf: { view: MarkdownView }) => void) => {
				for (const openView of openViews) callback({ view: openView });
			},
		},
	};

	const stableRead = async (): Promise<StableMarkdownReadResult> => ({
		kind: "ready",
		file: currentFile,
		content: disk,
		stat: { mtime: currentFile.stat.mtime, size: currentFile.stat.size },
	});

	controller = new ReconciliationController({
		app,
		getSettings: () => ({ deviceName: "test-device" }),
		getRuntimeConfig: () => ({}),
		getVaultSync: () => vaultSync,
		getDiskMirror: () => diskMirror,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings,
		getDiskIndex: () => diskIndexHash === null
			? ({})
			: ({
				[path]: {
					mtime: 1,
					size: base.length,
					contentHash: diskIndexHash,
				},
			}),
		setDiskIndex: () => {},
		getBaselineText: (hash: string) =>
			options.baselineAvailable !== false && hash === baselineHash ? base : null,
		recordConflictMergeBase: (artifactPath: string, hash: string) => {
			conflictMergeBases.set(artifactPath, hash);
		},
		isMarkdownPathSyncable: (candidate: string) => candidate === path,
		isRemoteProjectionAllowed: () => true,
		getMarkdownAttentionGeneration: () => 0,
		getMarkdownSyncScopeGeneration: () => 1,
		shouldTombstoneIntrinsicMarkdownPath: () => false,
		shouldTombstoneIntrinsicBlobPath: () => false,
		shouldBlockFrontmatterIngest: (
			candidate: string,
			previousContent: string | null,
			nextContent: string,
			reason: string,
		) => {
			frontmatterCalls.push(Object.freeze({
				path: candidate,
				previousContent,
				nextContent,
				reason,
			}));
			return options.frontmatterBlocked === true;
		},
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
		readStableMarkdownFile: stableRead,
	} as never);

	const mutationContext = (
		proposal: SamePathAdoptionProposal,
	): SamePathAdoptionMutationContext => Object.freeze({
		kind: "mutation",
		proposal,
		request: proposal.request,
	});
	const bindContext = (
		proposal: SamePathAdoptionProposal,
	): SamePathAdoptionBindContext => Object.freeze({
		kind: "bind",
		proposal,
		request: proposal.request,
		postMutation: undefined as never,
	});

	return {
		controller,
		request,
		async plan() {
			const result = await controller.requestSamePathAdoption(request());
			assert.equal(result.kind, "planned");
			if (result.kind !== "planned") throw new Error("Expected adoption proposal");
			return result.proposal;
		},
		mutationContext,
		bindContext,
		settleForBind(proposal: SamePathAdoptionProposal) {
			if (proposal.plan.kind === "preserve-conflict") {
				throw new Error("Expected a clean adoption proposal");
			}
			const targetText = proposal.plan.targetText;
			doc.transact(() => {
				remote.delete(0, remote.length);
				remote.insert(0, targetText);
			}, "same-path-adoption-test");
			mintedPostMutationProof = Object.freeze({
				targetText,
				openEditorTicket: currentTicket,
				editorAuthority: authority,
				hostCapability: proposal.hostCapability,
				hostSaveEpoch: proposal.hostSaveEpoch,
				cm,
				editorDocument: cm.state.doc,
				editorRevision,
				editorTransactionSeq,
				bindingEpoch: 2,
				nativeHistoryEpoch: 3,
				inputEpoch: 4,
				compositionEpoch,
				activeCompositionEpoch: null,
				selectionEpoch,
				scrollEpoch: 6,
				ytextIdentity: proposal.ytextIdentity,
				ytextMutationEpoch: proposal.ytextMutationEpoch + 1,
			});
			return Object.freeze({
				kind: "bind",
				proposal,
				request: proposal.request,
				postMutation: mintedPostMutationProof,
			});
		},
		mutateLocal() {
			local = `${local}typed`;
			editorRevision += 1;
			editorTransactionSeq += 1;
			cm.state = EditorState.create({ doc: local });
			currentTicket = makeTicket();
			authority = Object.freeze({ kind: "proven-single", content: local, lease });
		},
		mutateSelection() {
			selectionEpoch += 1;
			currentTicket = makeTicket();
		},
		startComposition() {
			compositionEpoch += 1;
			activeCompositionEpoch = compositionEpoch;
		},
		mutateProvider() {
			doc.transact(() => remote.insert(remote.length, "provider"));
		},
		replaceFile() {
			currentFile = file(path, disk, currentFile.stat.ctime + 1);
			view.file = currentFile;
			currentTicket = makeTicket();
		},
		advanceGeneration() {
			generation += 1;
			currentTicket = makeTicket();
		},
		advanceHostSave() {
			hostSaveEpoch += 1;
		},
		addPane(content = local) {
			const paneCm = {
				state: EditorState.create({ doc: content }),
			} as unknown as EditorView & { state: EditorState };
			const second = Object.assign(new MarkdownView(), {
				file: currentFile,
				leaf: { id: `leaf-secondary-${secondaryPanes.length}` },
				editor: { getValue: () => content },
			}) as MutableView;
			secondaryPanes.push(Object.freeze({ view: second, cm: paneCm, content }));
			openViews = [view, ...secondaryPanes.map((pane) => pane.view)];
			authority = content === local && secondaryPanes.every((pane) => pane.content === local)
				? Object.freeze({ kind: "proven-single", content: local, lease })
				: Object.freeze({ kind: "blocked", reason: "multiple" });
			currentTicket = makeTicket();
		},
		remoteText: () => remote.toJSON(),
		seedCalls: () => seedCalls,
		seededText: () => activeRemote?.toJSON() ?? null,
		frontmatterCalls: () => frontmatterCalls,
		activateProvider() {
			activeRemote = remote;
			activeFileId = "file-live";
		},
		currentFile: () => currentFile,
		localText: () => local,
		createdArtifacts: () => new Map(
			Array.from(createdArtifacts, ([artifactPath, entry]) => [artifactPath, entry.content]),
		),
		conflictMergeBases: () => new Map(conflictMergeBases),
		markBound(receipt) {
			boundReceipt = receipt;
		},
		diskFlushCalls: () => diskFlushCalls,
		baselinePublicationCount: () => baselinePublicationCount,
		diskCompletionCount: () => diskCompletionCount,
		diskInvalidationCount: () => diskInvalidationCount,
		attemptOrdinaryBaselineSettlement: () => (
			controller as unknown as {
				updateDiskIndexForPath(
					candidate: string,
					content: string,
					stat: { mtime: number; size: number },
					options: {
						expectedDiskFile: TFile;
						expectedYText: Y.Text | null;
						expectedCrdtContent: string | null;
					},
				): Promise<boolean>;
			}
		).updateDiskIndexForPath(
			path,
			disk,
			{ mtime: currentFile.stat.mtime, size: currentFile.stat.size },
			{
				expectedDiskFile: currentFile,
				expectedYText: activeRemote,
				expectedCrdtContent: activeRemote?.toJSON() ?? null,
			},
		),
		beginExternalProbe(sequence) {
			const ticket = controller.beginExternalDiskMutationProbe({
				file: currentFile,
				revision: Object.freeze({
					path,
					ctime: currentFile.stat.ctime,
					mtime: currentFile.stat.mtime,
					size: currentFile.stat.size,
				}),
				sequence,
				observedAt: sequence + 0.5,
			});
			assert.ok(ticket, "expected exact external probe ticket");
			return ticket;
		},
		settleExternalProbe(ticket) {
			return (controller as unknown as {
				noteExternalDiskMutationProbeSettled(
					candidate: ExternalDiskMutationProbeTicket,
				): Promise<boolean>;
			}).noteExternalDiskMutationProbeSettled(ticket);
		},
		markExternalProbeDisposition(ticket, disposition) {
			return controller.noteExternalDiskMutationProbeDisposition({
				ticket,
				disposition,
			});
		},
		artifactCreateStarted: () => artifactCreateStarted,
		releaseArtifactCreate,
	};
}

async function exactProposalAndCoalescing(): Promise<void> {
	const fixture = makeFixture();
	const request = fixture.request();
	assert.equal("inputGateInstalled" in request, false, "adoption request has no read-only gate");
	const firstPromise = fixture.controller.requestSamePathAdoption(request);
	const secondPromise = fixture.controller.requestSamePathAdoption(request);
	assert.equal(firstPromise, secondPromise, "the exact request object coalesces to one controller plan");
	const result = await firstPromise;
	assert.equal(result.kind, "planned");
	if (result.kind !== "planned") return;
	assert.equal(result.proposal.request, request);
	assert.equal(result.proposal.file, fixture.currentFile());
	assert.equal(result.proposal.hostSaveEpoch, 7);
	assert.equal(result.proposal.plan.kind, "apply-local");
	assert.equal(fixture.remoteText(), "# note\nbase\n", "planning mutates no remote Y.Text");
}

async function diskCannotBecomeAnImplicitFourthMergeBranch(): Promise<void> {
	const fixture = makeFixture({
		localText: "# note\nlocal\n",
		remoteText: "# note\nbase\n",
		diskText: "# unrelated external disk\n",
	});
	const result = await fixture.controller.requestSamePathAdoption(fixture.request());
	assert.equal(result.kind, "replan");
	if (result.kind !== "replan") return;
	assert.equal(result.reason, "disk-authority-unclassified");
	assert.equal(fixture.remoteText(), "# note\nbase\n");
	assert.equal(fixture.createdArtifacts().size, 0);
	fixture.controller.reset();
}

async function distinctOneShotPermits(): Promise<void> {
	const fixture = makeFixture();
	const proposal = await fixture.plan();
	const mutation = fixture.mutationContext(proposal);
	const bind = fixture.bindContext(proposal);
	assert.equal(
		fixture.controller.consumeSamePathAdoptionMutationPermit(
			proposal.bindPermit as never,
			mutation,
		),
		false,
		"bind permit cannot cross into the mutation action",
	);
	assert.equal(
		fixture.controller.consumeSamePathAdoptionMutationPermit(
			proposal.mutationPermit,
			mutation,
		),
		true,
	);
	assert.equal(
		fixture.controller.consumeSamePathAdoptionMutationPermit(
			proposal.mutationPermit,
			mutation,
		),
		false,
		"mutation permit is one-shot",
	);
	assert.equal(
		fixture.controller.consumeSamePathAdoptionBindPermit(
			proposal.mutationPermit as never,
			bind,
		),
		false,
		"mutation permit cannot cross into the bind action",
	);
	assert.equal(
		fixture.controller.consumeSamePathAdoptionBindPermit(proposal.bindPermit, bind),
		false,
		"the pre-mutation request cannot authorize the post-mutation bind",
	);
	const settledBind = fixture.settleForBind(proposal);
	assert.equal(
		fixture.controller.consumeSamePathAdoptionBindPermit(
			proposal.bindPermit,
			settledBind,
		),
		true,
		"the distinct bind permit accepts only a controller-validated post-mutation proof",
	);
	assert.equal(
		fixture.controller.consumeSamePathAdoptionBindPermit(
			proposal.bindPermit,
			settledBind,
		),
		false,
		"the post-mutation bind permit is one-shot",
	);

	const registry = new EditorAuthorityAdmissionRegistry();
	const seedRequest = fixture.request();
	const seedContext: SamePathAdoptionSeedContext = Object.freeze({
		kind: "seed",
		request: seedRequest,
		file: seedRequest.file,
		diskContent: "# note\nlocal\n",
	});
	const seedPermit = registry.issueSamePathAdoptionSeedPermit(
		seedContext,
		() => true,
	);
	assert.equal(registry.consumeSamePathAdoptionSeedPermit(seedPermit, seedContext), true);
	assert.equal(
		registry.consumeSamePathAdoptionSeedPermit(seedPermit, seedContext),
		false,
		"seed permit is one-shot",
	);
	assert.equal(
		registry.consumeSamePathAdoptionMutationPermit(seedPermit as never, mutation),
		false,
		"seed permit cannot cross into mutation",
	);
	registry.reset();
}

async function proposalInvalidationMatrix(): Promise<void> {
	const cases: Array<readonly [string, (fixture: Fixture) => void]> = [
		["local edit", (fixture) => fixture.mutateLocal()],
		["selection", (fixture) => fixture.mutateSelection()],
		["active composition", (fixture) => fixture.startComposition()],
		["provider mutation", (fixture) => fixture.mutateProvider()],
		["TFile replacement", (fixture) => fixture.replaceFile()],
		["generation", (fixture) => fixture.advanceGeneration()],
		["host save epoch", (fixture) => fixture.advanceHostSave()],
		["second pane", (fixture) => fixture.addPane()],
	];
	for (const [name, mutate] of cases) {
		const fixture = makeFixture();
		const proposal = await fixture.plan();
		mutate(fixture);
		assert.equal(
			fixture.controller.consumeSamePathAdoptionMutationPermit(
				proposal.mutationPermit,
				fixture.mutationContext(proposal),
			),
			false,
			`${name} invalidates the proposal`,
		);
	}
}

async function externalProbeAuthorityFencesAdoption(): Promise<void> {
	for (const disposition of [null, "unavailable", "stale"] as const) {
		const fixture = makeFixture();
		const ticket = fixture.beginExternalProbe(41);
		if (disposition !== null) {
			assert.equal(
				fixture.markExternalProbeDisposition(ticket, disposition),
				true,
				`${disposition} owns the exact event-start marker`,
			);
		}
		const result = await fixture.controller.requestSamePathAdoption(fixture.request());
		assert.equal(
			result.kind,
			"replan",
			`${disposition ?? "active"} external probe authority blocks same-path adoption`,
		);
		fixture.controller.reset();
	}
}

async function externalProbeAuthorityAbaInvalidatesPlanningAndPermit(): Promise<void> {
	const duringPlanning = makeFixture();
	const planning = duringPlanning.controller.requestSamePathAdoption(
		duringPlanning.request(),
	);
	const inFlight = duringPlanning.beginExternalProbe(51);
	assert.equal(
		await duringPlanning.settleExternalProbe(inFlight),
		true,
		"ordinary current completion retires the exact active ticket",
	);
	assert.equal(
		(await planning).kind,
		"replan",
		"a start-and-settle ABA during an awaited capture invalidates planning",
	);

	const afterProposal = makeFixture();
	const proposal = await afterProposal.plan();
	const replacement = afterProposal.beginExternalProbe(52);
	assert.equal(await afterProposal.settleExternalProbe(replacement), true);
	assert.equal(
		afterProposal.controller.consumeSamePathAdoptionMutationPermit(
			proposal.mutationPermit,
			afterProposal.mutationContext(proposal),
		),
		false,
		"a completed replacement event invalidates the final mutation permit CAS",
	);
}

async function equalSequenceStaleDispositionAbsorbsContentfulCandidate(): Promise<void> {
	const fixture = makeFixture();
	const ticket = fixture.beginExternalProbe(61);
	assert.equal(fixture.markExternalProbeDisposition(ticket, "stale"), true);
	const internals = fixture.controller as unknown as {
		pendingExternalDiskProbeDispositions: Map<string, object>;
		interceptedExternalDiskMutations: Map<string, object>;
	};
	const path = ticket.revision.path;
	const staleMarker = internals.pendingExternalDiskProbeDispositions.get(path);
	fixture.controller.noteInterceptedExternalDiskMutation(Object.freeze({
		path,
		ctime: ticket.revision.ctime,
		mtime: ticket.revision.mtime,
		size: ticket.revision.size,
		sequence: ticket.sequence,
		observedAt: ticket.observedAt,
		content: "same-sequence content must remain quarantined",
	}));
	assert.equal(
		internals.pendingExternalDiskProbeDispositions.get(path),
		staleMarker,
		"equal-sequence stale authority remains absorbing",
	);
	assert.equal(
		internals.interceptedExternalDiskMutations.has(path),
		false,
		"contentful completion cannot override an equal-sequence stale proof",
	);
	fixture.controller.reset();
}

async function outOfOrderProbeObligationWaitsForDurablePreservation(): Promise<void> {
	const fixture = makeFixture({ pauseArtifactCreate: true });
	const older = fixture.beginExternalProbe(71);
	const newer = fixture.beginExternalProbe(72);
	assert.equal(
		await fixture.settleExternalProbe(newer),
		true,
		"the higher no-candidate completion settles only its own exact obligation",
	);
	fixture.controller.noteInterceptedExternalDiskMutation(Object.freeze({
		path: older.revision.path,
		ctime: older.revision.ctime,
		mtime: older.revision.mtime,
		size: older.revision.size,
		sequence: older.sequence,
		observedAt: older.observedAt,
		content: "late older external bytes",
	}));
	for (let index = 0; index < 10 && !fixture.artifactCreateStarted(); index++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	assert.equal(
		fixture.artifactCreateStarted(),
		true,
		"the late lower candidate enters durable artifact preservation",
	);
	const internals = fixture.controller as unknown as {
		externalDiskMutationProbeObligations: Map<string, ReadonlyMap<number, object>>;
	};
	assert.equal(
		internals.externalDiskMutationProbeObligations
			.get(older.revision.path)?.has(older.sequence),
		true,
		"the lower exact obligation remains while artifact creation is paused",
	);
	assert.equal(
		(await fixture.controller.requestSamePathAdoption(fixture.request())).kind,
		"replan",
		"adoption stays closed throughout the paused durable-preservation window",
	);

	fixture.releaseArtifactCreate();
	for (let index = 0; index < 20; index++) {
		if (!internals.externalDiskMutationProbeObligations.has(older.revision.path)) break;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	assert.equal(
		internals.externalDiskMutationProbeObligations.has(older.revision.path),
		false,
		"durable preservation retires the final lower obligation",
	);
	assert.equal(
		fixture.createdArtifacts().size,
		1,
		"the late lower bytes are preserved exactly once",
	);
	assert.equal(
		(await fixture.controller.requestSamePathAdoption(fixture.request())).kind,
		"planned",
		"a fresh adoption may resume only after the durable barrier commits",
	);
	fixture.controller.reset();
}

async function samePathTFileReplacementRetiresOwnedProbeObligations(): Promise<void> {
	type ProbeInternals = {
		externalDiskMutationProbeObligations: Map<string, ReadonlyMap<number, object>>;
		pendingExternalDiskProbeDispositions: Map<string, object>;
		interceptedExternalDiskMutations: Map<string, object>;
	};
	const waitForObligationsToRetire = async (
		internals: ProbeInternals,
		path: string,
	): Promise<void> => {
		for (let index = 0; index < 40; index++) {
			if (!internals.externalDiskMutationProbeObligations.has(path)) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	};

	for (const [index, disposition] of (["stale", "unavailable"] as const).entries()) {
		const fixture = makeFixture();
		const older = fixture.beginExternalProbe(81 + index * 2);
		fixture.replaceFile();
		const newer = fixture.beginExternalProbe(82 + index * 2);
		const internals = fixture.controller as unknown as ProbeInternals;

		assert.equal(
			fixture.markExternalProbeDisposition(older, disposition),
			true,
			`a superseded ${disposition} result still owns its exact retirement obligation`,
		);
		assert.equal(
			await fixture.settleExternalProbe(newer),
			true,
			"the replacement TFile event settles its own exact obligation",
		);
		await waitForObligationsToRetire(internals, older.revision.path);
		assert.equal(
			internals.externalDiskMutationProbeObligations.has(older.revision.path),
			false,
			`the old ${disposition} result cannot strand same-path adoption`,
		);
		assert.equal(
			internals.pendingExternalDiskProbeDispositions.has(older.revision.path),
			false,
			"an old-TFile disposition never becomes the current TFile marker",
		);
		assert.equal(
			(await fixture.controller.requestSamePathAdoption(fixture.request())).kind,
			"planned",
			`adoption resumes after both ${disposition} obligations retire`,
		);
		fixture.controller.reset();
	}

	for (const [index, disposition] of (["stale", "unavailable"] as const).entries()) {
		const fixture = makeFixture();
		const replacedTicket = fixture.beginExternalProbe(87 + index);
		fixture.replaceFile();
		const internals = fixture.controller as unknown as ProbeInternals;

		assert.equal(
			fixture.markExternalProbeDisposition(replacedTicket, disposition),
			true,
			`same-sequence old-TFile ${disposition} is accepted for exact retirement`,
		);
		await waitForObligationsToRetire(internals, replacedTicket.revision.path);
		assert.equal(
			internals.pendingExternalDiskProbeDispositions.has(replacedTicket.revision.path),
			false,
			`same-sequence old-TFile ${disposition} never becomes current-path authority`,
		);
		assert.equal(
			internals.externalDiskMutationProbeObligations.has(replacedTicket.revision.path),
			false,
			`same-sequence old-TFile ${disposition} retires after its durable barrier`,
		);
		assert.equal(
			(await fixture.controller.requestSamePathAdoption(fixture.request())).kind,
			"planned",
			`adoption resumes after same-sequence old-TFile ${disposition}`,
		);
		fixture.controller.reset();
	}

	const lateCandidate = makeFixture();
	const older = lateCandidate.beginExternalProbe(91);
	lateCandidate.replaceFile();
	const newer = lateCandidate.beginExternalProbe(92);
	const lateInternals = lateCandidate.controller as unknown as ProbeInternals;
	const oldContent = "late bytes read from the replaced TFile";
	lateCandidate.controller.noteInterceptedExternalDiskMutation(Object.freeze({
		path: older.revision.path,
		ctime: older.revision.ctime,
		mtime: older.revision.mtime,
		size: older.revision.size,
		sequence: older.sequence,
		observedAt: older.observedAt,
		content: oldContent,
	}));
	assert.equal(
		await lateCandidate.settleExternalProbe(newer),
		true,
		"the successor waits for and settles the old candidate's durable barrier",
	);
	await waitForObligationsToRetire(lateInternals, older.revision.path);
	assert.equal(
		lateInternals.externalDiskMutationProbeObligations.has(older.revision.path),
		false,
		"durably preserved old-TFile bytes retire the final exact obligation",
	);
	assert.deepEqual(
		Array.from(lateCandidate.createdArtifacts().values()),
		[oldContent],
		"old-TFile bytes survive only as exact durable evidence",
	);
	assert.equal(
		lateInternals.interceptedExternalDiskMutations.has(older.revision.path),
		false,
		"old-TFile bytes are never admitted as the current external candidate",
	);
	assert.equal(
		(await lateCandidate.controller.requestSamePathAdoption(lateCandidate.request())).kind,
		"planned",
		"adoption resumes after the durable old-candidate handoff",
	);
	lateCandidate.controller.reset();

	const currentFileCas = makeFixture();
	const replacedTicket = currentFileCas.beginExternalProbe(101);
	currentFileCas.replaceFile();
	const casInternals = currentFileCas.controller as unknown as ProbeInternals;
	const replacedContent = "same-sequence bytes from a no-longer-current TFile";
	currentFileCas.controller.noteInterceptedExternalDiskMutation(Object.freeze({
		path: replacedTicket.revision.path,
		ctime: replacedTicket.revision.ctime,
		mtime: replacedTicket.revision.mtime,
		size: replacedTicket.revision.size,
		sequence: replacedTicket.sequence,
		observedAt: replacedTicket.observedAt,
		content: replacedContent,
	}));
	await waitForObligationsToRetire(casInternals, replacedTicket.revision.path);
	assert.equal(
		casInternals.interceptedExternalDiskMutations.has(replacedTicket.revision.path),
		false,
		"content admission retains the current-TFile identity CAS",
	);
	assert.deepEqual(
		Array.from(currentFileCas.createdArtifacts().values()),
		[replacedContent],
		"a same-sequence old-TFile callback is quarantined durably",
	);
	assert.equal(
		casInternals.externalDiskMutationProbeObligations.has(replacedTicket.revision.path),
		false,
		"durable quarantine retires the old exact obligation without a successor",
	);
	currentFileCas.controller.reset();
}

async function missingRemoteSeedsCertifiedDiskOnly(): Promise<void> {
	const fixture = makeFixture(true);
	const request = fixture.request();
	assert.equal(request.ytext, null);
	assert.equal(request.fileId, null);
	const result = await fixture.controller.requestSamePathAdoption(request);
	assert.equal(result.kind, "seeded-replan");
	assert.deepEqual(
		fixture.seedCalls(),
		["# note\nbase\n"],
		"the one-shot seed uses the second certified disk read, never captured Local",
	);
	assert.equal(fixture.seededText(), "# note\nbase\n");
	assert.notEqual(fixture.seededText(), request.startDocument.toString());
}

async function concurrentProviderCreationWinsSeedRace(): Promise<void> {
	const fixture = makeFixture(true);
	const planning = fixture.controller.requestSamePathAdoption(fixture.request());
	fixture.activateProvider();
	const result = await planning;
	assert.equal(result.kind, "replan");
	assert.deepEqual(fixture.seedCalls(), []);
	assert.equal(fixture.seededText(), "# note\nbase\n");
}

async function frontmatterQuarantineFencesOnlyNewSharedBytes(): Promise<void> {
	const seed = makeFixture({ remoteMissing: true, frontmatterBlocked: true });
	const seedResult = await seed.controller.requestSamePathAdoption(seed.request());
	assert.deepEqual(seedResult, { kind: "replan", reason: "frontmatter-blocked" });
	assert.deepEqual(seed.seedCalls(), [], "quarantined disk bytes never seed a missing Y.Text");
	assert.deepEqual(seed.frontmatterCalls(), [{
		path: "Notes/live-adoption.md",
		previousContent: null,
		nextContent: "# note\nbase\n",
		reason: "same-path-adoption-seed",
	}]);

	const applyLocal = makeFixture({ frontmatterBlocked: true });
	const localResult = await applyLocal.controller.requestSamePathAdoption(
		applyLocal.request(),
	);
	assert.deepEqual(localResult, { kind: "replan", reason: "frontmatter-blocked" });
	assert.deepEqual(applyLocal.frontmatterCalls(), [{
		path: "Notes/live-adoption.md",
		previousContent: "# note\nbase\n",
		nextContent: "# note\nlocal\n",
		reason: "same-path-adoption-apply-local",
	}]);

	const cleanMerge = makeFixture({
		localText: "# NOTE\nbase\n",
		diskText: "# NOTE\nbase\n",
		remoteText: "# note\nbase\nremote\n",
		frontmatterBlocked: true,
	});
	const mergeResult = await cleanMerge.controller.requestSamePathAdoption(
		cleanMerge.request(),
	);
	assert.deepEqual(mergeResult, { kind: "replan", reason: "frontmatter-blocked" });
	assert.deepEqual(cleanMerge.frontmatterCalls(), [{
		path: "Notes/live-adoption.md",
		previousContent: "# note\nbase\nremote\n",
		nextContent: "# NOTE\nbase\nremote\n",
		reason: "same-path-adoption-apply-clean-merge",
	}]);

	const applyRemote = makeFixture({
		localText: "# note\nbase\n",
		diskText: "# note\nbase\n",
		remoteText: "# note\nremote\n",
		frontmatterBlocked: true,
	});
	const remoteResult = await applyRemote.controller.requestSamePathAdoption(
		applyRemote.request(),
	);
	assert.equal(remoteResult.kind, "planned");
	if (remoteResult.kind === "planned") {
		assert.equal(remoteResult.proposal.plan.kind, "apply-remote");
	}
	assert.deepEqual(
		applyRemote.frontmatterCalls(),
		[],
		"projecting already-shared Remote bytes into Local invokes no disk-to-CRDT gate",
	);
}

async function conflictEvidenceIsExactAndNonMutating(): Promise<void> {
	const remoteText = "# note\nremote\n";
	const diskLocal = makeFixture({ remoteText });
	const beforeLocal = diskLocal.localText();
	const result = await diskLocal.controller.requestSamePathAdoption(diskLocal.request());
	assert.equal(result.kind, "conflict-preserved", JSON.stringify(result));
	if (result.kind !== "conflict-preserved") return;
	assert.equal(result.receipt.status, "preserved");
	assert.equal(result.receipt.mergeMode, "three-way");
	assert.equal(result.receipt.crdtArtifactPath !== null, true);
	assert.deepEqual(result.receipt.editorArtifacts, []);
	assert.equal(diskLocal.localText(), beforeLocal, "conflict preservation does not edit Local");
	assert.equal(diskLocal.remoteText(), remoteText, "conflict preservation does not edit Y.Text");
	const artifacts = diskLocal.createdArtifacts();
	assert.equal(artifacts.size, 1, "disk==Local needs only the Remote artifact");
	assert.equal(artifacts.get(result.receipt.crdtArtifactPath ?? ""), remoteText);
	assert.equal(
		diskLocal.conflictMergeBases().get(result.receipt.crdtArtifactPath ?? ""),
		result.receipt.baseHash,
		"a verified Remote artifact pins the current Base",
	);
	const replay = await diskLocal.controller.requestSamePathAdoption(diskLocal.request());
	assert.equal(replay.kind, "conflict-preserved");
	if (replay.kind === "conflict-preserved") {
		assert.equal(replay.receipt.crdtArtifactPath, result.receipt.crdtArtifactPath);
		assert.equal(diskLocal.createdArtifacts().size, 1, "retry dedupes exact evidence");
	}

	const unsavedLocal = makeFixture({
		remoteText,
		diskText: "# note\nbase\n",
	});
	const unsavedResult = await unsavedLocal.controller.requestSamePathAdoption(
		unsavedLocal.request(),
	);
	assert.equal(unsavedResult.kind, "conflict-preserved");
	if (unsavedResult.kind !== "conflict-preserved") return;
	assert.equal(unsavedResult.receipt.editorArtifacts.length, 1);
	const editorArtifact = unsavedResult.receipt.editorArtifacts[0];
	assert.ok(editorArtifact);
	assert.equal(
		unsavedLocal.createdArtifacts().get(editorArtifact.path),
		unsavedLocal.localText(),
		"an unsaved Local is preserved exactly once",
	);
	assert.equal(
		unsavedLocal.conflictMergeBases().get(editorArtifact.path),
		unsavedResult.receipt.baseHash,
		"the Local artifact is associated with the same Base",
	);
	assert.equal(unsavedLocal.localText().includes("<<<<<<<"), false);
	assert.equal(unsavedLocal.remoteText().includes("<<<<<<<"), false);
}

async function missingBaseIsExplicitTwoWayEvidence(): Promise<void> {
	const fixture = makeFixture({
		remoteText: "# note\nremote\n",
		diskText: "# note\nbase\n",
		baselineAvailable: false,
	});
	const result = await fixture.controller.requestSamePathAdoption(fixture.request());
	assert.equal(result.kind, "conflict-preserved");
	if (result.kind !== "conflict-preserved") return;
	assert.equal(result.receipt.baseHash, null);
	assert.equal(result.receipt.mergeMode, "two-way");
	assert.equal(fixture.conflictMergeBases().size, 0);
	assert.equal(fixture.remoteText(), "# note\nremote\n");
	assert.equal(fixture.localText(), "# note\nlocal\n");
}

async function conflictArtifactFailureIsVisibleAndRetryable(): Promise<void> {
	for (const [name, options] of [
		["create failure", { failArtifactCreate: true }],
		["reread mismatch", { artifactReadMismatch: true }],
	] as const) {
		const fixture = makeFixture({
			remoteText: "# note\nremote\n",
			diskText: "# note\nbase\n",
			...options,
		});
		const result = await fixture.controller.requestSamePathAdoption(fixture.request());
		assert.equal(result.kind, "conflict-preservation-failed", name);
		if (result.kind !== "conflict-preservation-failed") continue;
		assert.equal(result.receipt.status, "preservation-failed");
		assert.equal(result.receipt.retryable, true);
		assert.equal(result.reason, "artifact-preservation-failed");
		assert.equal(result.receipt.failureReason, "artifact-preservation-failed");
		assert.equal(
			JSON.stringify(result).includes("private-note-body"),
			false,
			"adapter error text never enters the conflict receipt",
		);
		assert.equal(fixture.conflictMergeBases().size, 0);
		assert.equal(fixture.remoteText(), "# note\nremote\n");
		assert.equal(fixture.localText(), "# note\nlocal\n");
	}
}

async function stalePostCreateEvidenceCannotSettle(): Promise<void> {
	const fixture = makeFixture({
		remoteText: "# note\nremote\n",
		diskText: "# note\nbase\n",
		staleAfterArtifactCreate: true,
	});
	const first = await fixture.controller.requestSamePathAdoption(fixture.request());
	assert.equal(first.kind, "conflict-preservation-failed");
	assert.equal(fixture.createdArtifacts().size, 1, "already-created evidence is retained");
	assert.equal(
		fixture.conflictMergeBases().size,
		0,
		"stale post-create work cannot publish a Base association",
	);
	assert.equal(fixture.localText(), "# note\nlocal\n");
	assert.equal(fixture.remoteText(), "# note\nremote\nprovider-advanced");
}

async function compositePaneLocalsAreDedupedByExactContent(): Promise<void> {
	const distinct = makeFixture({
		remoteText: "# note\nremote\n",
		diskText: "# note\nbase\n",
	});
	distinct.addPane("# note\nsecond-local\n");
	const distinctRequest = distinct.request();
	assert.equal(distinctRequest.openEditorTicket.views.length, 2);
	assert.deepEqual(distinctRequest.editorAuthority, {
		kind: "blocked",
		reason: "multiple",
	});
	const distinctResult = await distinct.controller.requestSamePathAdoption(distinctRequest);
	assert.equal(distinctResult.kind, "conflict-preserved", JSON.stringify(distinctResult));
	if (distinctResult.kind !== "conflict-preserved") return;
	assert.equal(distinctResult.receipt.editorArtifacts.length, 2);
	assert.deepEqual(
		new Set(distinctResult.receipt.editorArtifacts.flatMap((entry) => entry.leafIds)),
		new Set(["leaf-live", "leaf-secondary-0"]),
	);
	assert.deepEqual(
		new Set(
			distinctResult.receipt.editorArtifacts.map((entry) =>
				distinct.createdArtifacts().get(entry.path)
			),
		),
		new Set(["# note\nlocal\n", "# note\nsecond-local\n"]),
	);
	assert.equal(distinct.remoteText(), "# note\nremote\n");

	const identical = makeFixture({
		remoteText: "# note\nremote\n",
		diskText: "# note\nbase\n",
	});
	identical.addPane();
	const identicalResult = await identical.controller.requestSamePathAdoption(
		identical.request(),
	);
	assert.equal(identicalResult.kind, "conflict-preserved");
	if (identicalResult.kind !== "conflict-preserved") return;
	assert.equal(
		identicalResult.receipt.editorArtifacts.length,
		1,
		"identical pane Locals share one exact editor artifact",
	);
	assert.deepEqual(
		identicalResult.receipt.editorArtifacts[0]?.leafIds,
		["leaf-live", "leaf-secondary-0"],
	);
	assert.equal(identical.createdArtifacts().size, 2, "one Remote plus one Local artifact");
}

async function identicalPaneCleanMergeIsPlannable(): Promise<void> {
	const base = "# note\nbase\n";
	const local = "# NOTE\nbase\n";
	const remote = "# note\nbase\nremote\n";
	const fixture = makeFixture({
		localText: local,
		diskText: local,
		remoteText: remote,
	});
	fixture.addPane();
	const result = await fixture.controller.requestSamePathAdoption(fixture.request());
	assert.equal(result.kind, "planned", JSON.stringify(result));
	if (result.kind !== "planned") return;
	assert.equal(result.proposal.baselineText, base);
	assert.equal(result.proposal.request.openEditorTicket.views.length, 2);
	assert.equal(result.proposal.editorAuthorityLease, result.proposal.request.editorAuthority.kind === "proven-single"
		? result.proposal.request.editorAuthority.lease
		: null);
	assert.deepEqual(result.proposal.plan, {
		kind: "apply-clean-merge",
		targetText: "# NOTE\nbase\nremote\n",
	});
}

async function prepareBoundReceipt(fixture: Fixture) {
		const proposal = await fixture.plan();
		assert.equal(
			fixture.controller.consumeSamePathAdoptionMutationPermit(
				proposal.mutationPermit,
				fixture.mutationContext(proposal),
			),
			true,
		);
		const bindContext = fixture.settleForBind(proposal);
		assert.equal(
			fixture.controller.consumeSamePathAdoptionBindPermit(
				proposal.bindPermit,
				bindContext,
			),
			true,
		);
		const receipt = Object.freeze({
			receiptId: `receipt-${proposal.proposalId}`,
			proposalId: proposal.proposalId,
			adoptionId: proposal.adoptionId,
			path: proposal.path,
			file: proposal.file,
			fileId: proposal.fileId,
			ytext: proposal.ytext,
			ytextIdentity: bindContext.postMutation.ytextIdentity,
			ytextMutationEpoch: bindContext.postMutation.ytextMutationEpoch,
			targetText: proposal.plan.kind === "preserve-conflict"
				? (() => { throw new Error("Expected clean proposal"); })()
				: proposal.plan.targetText,
		});
		fixture.markBound(receipt);
		return receipt;
}

async function exactBoundFlushOwnsBaselineSettlement(): Promise<void> {
	const run = async (fixture: Fixture) => {
		const receipt = await prepareBoundReceipt(fixture);
		fixture.controller.noteSamePathAdoptionBound(receipt);
		await Promise.resolve();
		await Promise.resolve();
		return receipt;
	};

	const clean = makeFixture();
	const cleanReceipt = await run(clean);
	assert.deepEqual(clean.diskFlushCalls(), [{ path: cleanReceipt.path, force: true }]);
	assert.equal(clean.baselinePublicationCount(), 1);
	assert.equal(clean.diskCompletionCount(), 1);
	assert.equal(clean.diskInvalidationCount(), 0);
	clean.controller.reset();

	const stale = makeFixture({ advanceProviderBeforeDiskFlush: true });
	await run(stale);
	assert.equal(stale.diskFlushCalls().length, 1);
	assert.equal(stale.baselinePublicationCount(), 0);
	assert.equal(stale.diskCompletionCount(), 0);
	assert.equal(stale.diskInvalidationCount(), 1);
	assert.equal(
		stale.remoteText(),
		"# note\nlocal\nprovider-before-flush",
		"a provider advance survives the rejected stale settlement",
	);
	stale.controller.reset();
}

async function adoptionHoldBlocksEveryOrdinaryBaselineLane(): Promise<void> {
	const fixture = makeFixture();
	await prepareBoundReceipt(fixture);
	assert.equal(
		await fixture.attemptOrdinaryBaselineSettlement(),
		false,
		"a generic reconciliation settlement cannot advance Base while adoption owns the path",
	);
	fixture.controller.reset();
}

async function rejectedBoundReceiptTransfersToFreshWork(): Promise<void> {
	const fixture = makeFixture({ rejectBoundSettlementCurrent: true });
	const receipt = await prepareBoundReceipt(fixture);
	fixture.controller.noteSamePathAdoptionBound(receipt);
	await Promise.resolve();
	assert.equal(fixture.diskFlushCalls().length, 0);
	assert.equal(
		fixture.diskInvalidationCount(),
		1,
		"an already-stale bound receipt cannot leave an unowned projection hold",
	);
	fixture.controller.reset();
}

async function managerStartsOneEditableAdoption(): Promise<void> {
	const path = "Notes/manager-adoption.md";
	const local = "# manager\nlocal\n";
	const remoteDoc = new Y.Doc();
	const remote = remoteDoc.getText("manager-remote");
	remote.insert(0, "# manager\nbase\n");
	const targetFile = file(path, local);
	const cm = {
		state: EditorState.create({ doc: local }),
	} as unknown as EditorView;
	const view = Object.assign(new MarkdownView(), {
		file: targetFile,
		leaf: { id: "leaf-manager-adoption" },
		containerEl: { contains: () => true },
		editor: { getValue: () => local },
		getViewData: () => local,
	}) as MarkdownView & {
		file: TFile;
		leaf: { id: string };
		getViewData(): string;
	};
	Object.assign(view, {
		app: {
			workspace: {
				iterateAllLeaves(callback: (leaf: { view: MarkdownView }) => void) {
					callback({ view });
				},
			},
		},
	});
	const requests: SamePathAdoptionRequest[] = [];
	const controllerPort = {
		requestSamePathAdoption(request: SamePathAdoptionRequest) {
			requests.push(request);
			return new Promise<never>(() => {});
		},
	};
	const vaultSync = {
		ydoc: remoteDoc,
		provider: { awareness: { setLocalStateField: () => {} } },
		getTextForPath: (candidate: string) => candidate === path ? remote : null,
		getFileId: (candidate: string) => candidate === path ? "manager-file" : undefined,
		getFileIdForText: (candidate: Y.Text) =>
			candidate === remote ? "manager-file" : undefined,
		isPendingRenameTarget: () => false,
		isMarkdownTombstoned: () => false,
	};
	const manager = new EditorBindingManager(
		vaultSync as never,
		false,
		(candidate) => candidate === path,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		controllerPort as never,
	);
	(manager as unknown as { getCmView: () => EditorView }).getCmView = () => cm;
	manager.manageView(view);
	const runtime = (manager as unknown as {
		managedSessions: Map<string, {
			hostGuard: unknown;
			cmGuard: unknown;
			adoption: { kind: string; requestId?: string | null };
		}>;
	}).managedSessions.get(view.leaf.id);
	assert.ok(runtime);
	let selectionEpoch = 0;
	runtime.hostGuard = {
		snapshot: () => ({
			leafId: view.leaf.id,
			view,
			hostCapability: "owned-scheduler-with-unload-flush",
			hostCapabilityState: "ready",
			wrappersCurrent: true,
			loadWrappersCurrent: true,
			saveEpoch: 9,
			clearLoadCapability: "observable",
			mode: { kind: "pass-through" },
			inFlight: new Map(),
			pendingTargetSave: false,
			pendingOwnedSave: null,
			sourceUnload: null,
			pendingDeferredLoadAdmission: null,
			pendingSourceUnloadDrain: null,
		}),
		markInert: () => true,
		restoreIfCurrent: () => true,
	};
	runtime.cmGuard = {
		snapshot: () => ({
			view: cm,
			inert: false,
			gateClosed: false,
			inputEpoch: 3,
			compositionEpoch: 4,
			nativeHistoryEpoch: 0,
			selectionEpoch,
			scrollEpoch: 2,
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
	manager.manageView(view);
	assert.equal(
		manager.getManagedSession(view)?.displayedLineage.kind,
		"known",
		"the guarded host view establishes stable same-path presentation",
	);
	const resolve = (manager as unknown as {
		resolveBindingTarget(
			view: MarkdownView,
			deviceName: string,
			reason: string,
		): unknown;
	}).resolveBindingTarget.bind(manager);
	assert.equal(resolve(view, "test-device", "same-path-test"), null);
	assert.equal(resolve(view, "test-device", "same-path-test-repeat"), null);
	assert.equal(requests.length, 1, "one exact divergent tuple starts one request");
	const request = requests[0];
	assert.ok(request);
	assert.equal("inputGateInstalled" in request, false);
	assert.equal(request.openEditorTicket.views.length, 1);
	assert.equal(request.hostSaveEpoch, 9);
	assert.equal(request.cm, cm);
	assert.equal(runtime.adoption.kind, "planning");
	assert.equal(manager.getBinding(view), null, "planning leaves yCollab detached");
	assert.equal(
		(runtime.cmGuard as { snapshot(): { gateClosed: boolean } }).snapshot().gateClosed,
		false,
		"planning leaves the editor writable",
	);
	assert.equal(manager.isSamePathAdoptionRequestCurrent(request), true);
	selectionEpoch += 1;
	assert.equal(
		manager.isSamePathAdoptionRequestCurrent(request),
		false,
		"selection movement invalidates the exact manager request",
	);
	manager.revokeAsyncAuthority();
}

await exactProposalAndCoalescing();
await diskCannotBecomeAnImplicitFourthMergeBranch();
await distinctOneShotPermits();
await proposalInvalidationMatrix();
await externalProbeAuthorityFencesAdoption();
await externalProbeAuthorityAbaInvalidatesPlanningAndPermit();
await equalSequenceStaleDispositionAbsorbsContentfulCandidate();
await outOfOrderProbeObligationWaitsForDurablePreservation();
await samePathTFileReplacementRetiresOwnedProbeObligations();
await missingRemoteSeedsCertifiedDiskOnly();
await concurrentProviderCreationWinsSeedRace();
await frontmatterQuarantineFencesOnlyNewSharedBytes();
await conflictEvidenceIsExactAndNonMutating();
await missingBaseIsExplicitTwoWayEvidence();
await conflictArtifactFailureIsVisibleAndRetryable();
await stalePostCreateEvidenceCannotSettle();
await compositePaneLocalsAreDedupedByExactContent();
await identicalPaneCleanMergeIsPlannable();
await exactBoundFlushOwnsBaselineSettlement();
await adoptionHoldBlocksEveryOrdinaryBaselineLane();
await rejectedBoundReceiptTransfersToFreshWork();
await managerStartsOneEditableAdoption();

console.log("same path adoption controller: PASS");
