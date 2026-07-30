import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { MarkdownView, TFile, type TextFileView } from "obsidian";
import * as Y from "yjs";
import {
	ReconciliationController,
	type StableMarkdownReadResult,
} from "../src/runtime/reconciliationController";
import type {
	OpenEditorMutationTicket,
	OpenEditorMutationViewTicket,
} from "../src/sync/editorBinding";
import type {
	HostLoadCompletionReceipt,
	PendingHostLoadCandidate,
	TargetReadyToken,
} from "../src/sync/editorHandoffState";
import type {
	BindPermitContext,
	OpenPathAdmissionRequest,
	OpenPathAdmissionResult,
	TargetPresentationPermitContext,
	TargetPresentationRequest,
} from "../src/runtime/editorAuthorityAdmission";
import type { EnsureFileResult, VaultSync } from "../src/sync/vaultSync";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): asserts condition {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed += 1;
		return;
	}
	console.error(`  FAIL  ${message}`);
	failed += 1;
}

function assertEq<T>(actual: T, expected: T, message: string): void {
	assert(actual === expected, `${message} (expected=${String(expected)}, actual=${String(actual)})`);
}

type MutableTFile = TFile & {
	path: string;
	stat: { ctime: number; mtime: number; size: number };
};

type MutableMarkdownView = MarkdownView & {
	file: TFile | null;
	leaf: { id: string };
	editor: { getValue(): string };
};

interface FixtureOptions {
	diskContent?: string;
	existingContent?: string | null;
	remoteProjectionAllowed?: boolean;
	attention?: boolean;
	tombstoned?: boolean;
	pendingRename?: boolean;
	frontmatterBlocked?: boolean;
}

interface AdmissionFixture {
	path: string;
	file: MutableTFile;
	view: MutableMarkdownView;
	cm: EditorView;
	controller: ReconciliationController;
	get ticket(): OpenEditorMutationTicket;
	get ytext(): Y.Text | null;
	get fileId(): string | null;
	get ensureCount(): number;
	setTicket(input: {
		presentation: OpenEditorMutationViewTicket["handoffPresentation"];
		content: string;
		pendingHostLoadTokenId?: string | null;
		displayedFile?: TFile;
		displayedPath?: string;
		editorRevision?: number;
		selectionEpoch?: number;
		scrollEpoch?: number;
		editorDocument?: unknown;
	}): OpenEditorMutationTicket;
	makeCandidate(
		source: string,
		target: string,
		applicationKind?: "transaction" | "state",
	): PendingHostLoadCandidate;
	acceptCandidate(candidate: PendingHostLoadCandidate): void;
	setCmContent(content: string): void;
	setDiskContent(content: string): void;
	makePresentationRequest(candidate: PendingHostLoadCandidate): TargetPresentationRequest;
	makeAdmissionRequest(
		presentation: OpenPathAdmissionRequest["presentation"],
		hostLoadTokenId?: string | null,
	): OpenPathAdmissionRequest;
	makeHostReceipt(candidate: PendingHostLoadCandidate): HostLoadCompletionReceipt;
	setAttention(value: boolean): void;
	setTombstoned(value: boolean): void;
	setPendingRename(value: boolean): void;
	setFrontmatterBlocked(value: boolean): void;
	setActive(fileId: string | null, ytext: Y.Text | null): void;
	setActiveIds(fileIds: string[]): void;
	setOpenViews(views: MutableMarkdownView[]): void;
	replaceFile(): MutableTFile;
	setStableReadHook(hook: (() => Promise<void>) | null): void;
	setEnsureHook(hook: (() => void) | null): void;
	setValidationHook(hook: (() => void) | null): void;
}

function makeFile(path: string, content: string, nonce = 1): MutableTFile {
	return Object.assign(new TFile(), {
		path,
		stat: {
			ctime: nonce,
			mtime: nonce,
			size: content.length,
		},
	}) as MutableTFile;
}

function makeFixture(options: FixtureOptions = {}): AdmissionFixture {
	const path = "notes/B.md";
	let diskContent = options.diskContent ?? "target-B";
	let file = makeFile(path, diskContent);
	const sourceFile = makeFile("notes/A.md", diskContent, 2);
	const view = Object.assign(new MarkdownView(), {
		file,
		leaf: { id: "leaf-1" },
		editor: { getValue: () => currentTicket.views[0]?.editorContent ?? "" },
	}) as MutableMarkdownView;
	const cm = {
		id: "cm-1",
		state: EditorState.create({ doc: diskContent }),
	} as unknown as EditorView & { state: EditorState };
	const ydoc = new Y.Doc();
	const authorityTick = ydoc.getMap<number>("admission-test-tick");
	let authorityTickValue = 0;
	let currentYtext: Y.Text | null = null;
	let currentFileId: string | null = null;
	let activeIds: string[] = [];
	let ensureCount = 0;
	let attention = options.attention === true;
	let tombstoned = options.tombstoned === true;
	let pendingRename = options.pendingRename === true;
	let frontmatterBlocked = options.frontmatterBlocked === true;
	let remoteProjectionAllowed = options.remoteProjectionAllowed !== false;
	let stableReadHook: (() => Promise<void>) | null = null;
	let ensureHook: (() => void) | null = null;
	let validationHook: (() => void) | null = null;
	let openViews: MutableMarkdownView[] = [view];
	let ticketSequence = 0;
	let requestSequence = 0;

	const bumpAuthority = (): void => {
		ydoc.transact(() => {
			authorityTick.set("value", ++authorityTickValue);
		});
	};

	const setActive = (nextFileId: string | null, nextYtext: Y.Text | null): void => {
		currentFileId = nextFileId;
		currentYtext = nextYtext;
		activeIds = nextFileId ? [nextFileId] : [];
		bumpAuthority();
	};

	if (options.existingContent !== undefined && options.existingContent !== null) {
		const existing = ydoc.getText("existing-B");
		existing.insert(0, options.existingContent);
		setActive("file-B", existing);
	}

	const makeTicket = (input: {
		presentation: OpenEditorMutationViewTicket["handoffPresentation"];
		content: string;
		pendingHostLoadTokenId?: string | null;
		displayedFile?: TFile;
		displayedPath?: string;
		editorRevision?: number;
		selectionEpoch?: number;
		scrollEpoch?: number;
		editorDocument?: unknown;
	}): OpenEditorMutationTicket => {
		const displayedFile = input.displayedFile ?? (
			input.presentation === "target-proven" || input.presentation === "stable"
				? file
				: sourceFile
		);
		const displayedPath = input.displayedPath ?? displayedFile.path;
		const handoff = input.presentation === "stable" ? null : input.presentation;
		const snapshot: OpenEditorMutationViewTicket = Object.freeze({
			bootSessionId: "boot-1",
			sessionId: "session-1",
			handoffGeneration: 1,
			displayedFile,
			displayedPath,
			targetFile: file,
			stableTargetIdentityProven: true,
			switchIntentSeq: 7,
			nativeHistoryEpoch: 0,
			selectionEpoch: input.selectionEpoch ?? 0,
			scrollEpoch: input.scrollEpoch ?? 0,
			handoffPresentation: input.presentation,
			handoffPhase: handoff === null
				? null
				: (handoff === "target-proven" ? "target-ready" : "awaiting-target-ready"),
			intentStateKind: handoff === null ? null : "none",
			pendingHostLoadTokenId: input.pendingHostLoadTokenId ?? null,
			view,
			viewId: "view-1",
			leafId: "leaf-1",
			cm,
			cmId: "cm-1",
			bindingEpoch: 3,
			editorRevision: input.editorRevision ?? ++ticketSequence,
			editorAuthorityRevision: 0,
			editorAuthorityContent: null,
			editorDocument: input.editorDocument ?? Object.freeze({ ticketSequence }),
			editorContent: input.content,
		});
		return Object.freeze({ path, views: Object.freeze([snapshot]) });
	};

	let currentTicket = makeTicket({
		presentation: "target-proven",
		content: diskContent,
	});

	const stableRead = async (): Promise<StableMarkdownReadResult> => {
		await stableReadHook?.();
		return {
			kind: "ready",
			file,
			content: diskContent,
			stat: { mtime: file.stat.mtime, size: file.stat.size },
		};
	};

	const vaultSync = {
		ydoc,
		getActiveFileIdsForPath: (candidatePath: string) =>
			candidatePath === path ? [...activeIds] : [],
		getTextForPath: (candidatePath: string) =>
			candidatePath === path ? currentYtext : null,
		getFileId: (candidatePath: string) =>
			candidatePath === path ? (currentFileId ?? undefined) : undefined,
		getFileIdForText: (candidate: Y.Text) =>
			candidate === currentYtext ? (currentFileId ?? undefined) : undefined,
		isMarkdownTombstoned: (candidatePath: string) => candidatePath === path && tombstoned,
		isPendingRenameTarget: (candidatePath: string) =>
			candidatePath === path && pendingRename,
		ensureFile: (
			candidatePath: string,
			content: string,
			_device?: string,
			ensureOptions?: { canCreate?: () => boolean },
		): EnsureFileResult => {
			ensureCount += 1;
			if (candidatePath !== path || ensureOptions?.canCreate?.() === false) {
				return { kind: "blocked", reason: "policy" };
			}
			if (tombstoned) return { kind: "blocked", reason: "tombstone" };
			if (activeIds.length > 1) return { kind: "blocked", reason: "collision" };
			if (currentYtext && currentFileId) {
				return { kind: "existing", fileId: currentFileId, ytext: currentYtext };
			}
			const created = ydoc.getText(`created-${ensureCount}`);
			currentFileId = `created-${ensureCount}`;
			currentYtext = created;
			activeIds = [currentFileId];
			ydoc.transact(() => created.insert(0, content));
			ensureHook?.();
			return { kind: "created", fileId: currentFileId, ytext: created };
		},
	} as unknown as VaultSync;

	const editorBindings = {
		captureOpenEditorMutationTicket: () => currentTicket,
		validateOpenEditorMutationTicket: (
			candidate: OpenEditorMutationTicket,
			views: readonly MarkdownView[],
		) => {
			validationHook?.();
			return candidate === currentTicket && views.length === openViews.length
				? { current: true as const }
				: { current: false as const, reason: "view-set-changed" as const };
		},
		getPendingHostLoadCandidate: () => pendingCandidate,
	};
	let pendingCandidate: PendingHostLoadCandidate | null = null;

	const diskMirror = {
		isPreservedUnresolved: (candidatePath: string) => candidatePath === path && attention,
		getPreservedUnresolvedEntries: () => attention
			? [{ kind: "markdown", path, reason: "remote-delete", firstSeenAt: "1", lastSeenAt: "1" }]
			: [],
	};

	const app = {
		vault: {
			getAbstractFileByPath: (candidatePath: string) => candidatePath === path ? file : null,
			read: async () => diskContent,
			adapter: {
				stat: async () => ({ mtime: file.stat.mtime, size: file.stat.size }),
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

	const controller = new ReconciliationController({
		app,
		getSettings: () => ({ deviceName: "test-device" }),
		getRuntimeConfig: () => ({}),
		getVaultSync: () => vaultSync,
		getDiskMirror: () => diskMirror,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings,
		getDiskIndex: () => ({
			[path]: {
				mtime: file.stat.mtime,
				size: file.stat.size,
				contentHash: "baseline-B",
			},
		}),
		setDiskIndex: () => {},
		isMarkdownPathSyncable: (candidatePath: string) => candidatePath === path,
		isRemoteProjectionAllowed: () => remoteProjectionAllowed,
		getMarkdownAttentionGeneration: () => attention ? 1 : 0,
		getMarkdownSyncScopeGeneration: () => 1,
		shouldTombstoneIntrinsicMarkdownPath: () => false,
		shouldTombstoneIntrinsicBlobPath: () => false,
		shouldBlockFrontmatterIngest: () => frontmatterBlocked,
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

	const makeCandidate = (
		source: string,
		target: string,
		applicationKind: "transaction" | "state" = "transaction",
	): PendingHostLoadCandidate => {
		const state = EditorState.create({ doc: source });
		const heldTransaction = state.update({
			changes: { from: 0, to: source.length, insert: target },
			selection: EditorSelection.cursor(target.length),
		});
		const heldState = EditorState.create({
			doc: target,
			selection: EditorSelection.cursor(target.length),
		});
		const common = {
			hostLoadTokenId: `host-${++requestSequence}`,
			hostLoadCompletedEpoch: null,
			sourceUnloadReceiptId: `source-unload:${requestSequence}`,
			switchIntentSeq: 7,
			sessionId: "session-1",
			leafId: "leaf-1",
			handoffGeneration: 1,
			targetPathAtDispatch: path,
			cm,
			runtimeView: view as unknown as TextFileView,
			startDocument: state.doc,
			targetDocument: applicationKind === "transaction"
				? heldTransaction.newDoc
				: heldState.doc,
			incomingContent: target,
			hostSetViewDataClear: true,
			nativeHistoryEpochBefore: 0,
			proposedSelection: applicationKind === "transaction"
				? heldTransaction.newSelection
				: heldState.selection,
			proposedScrollAnchor: 0,
			effectFingerprint: `effect-${requestSequence}`,
			runtimeViewDataBefore: source,
			bindingEpoch: 3,
			editorRevisionBefore: 9,
		} as const;
		const candidate: PendingHostLoadCandidate = applicationKind === "transaction"
			? Object.freeze({
				...common,
				applicationKind,
				heldTransaction,
				heldState: null,
			})
			: Object.freeze({
				...common,
				applicationKind,
				heldTransaction: null,
				heldState,
			});
		pendingCandidate = candidate;
		currentTicket = makeTicket({
			presentation: "target-candidate",
			content: source,
			pendingHostLoadTokenId: candidate.hostLoadTokenId,
			displayedFile: sourceFile,
			editorDocument: state.doc,
			editorRevision: 9,
		});
		return candidate;
	};

	return {
		path,
		get file() { return file; },
		view,
		cm,
		controller,
		get ticket() { return currentTicket; },
		get ytext() { return currentYtext; },
		get fileId() { return currentFileId; },
		get ensureCount() { return ensureCount; },
		setTicket(input) {
			currentTicket = makeTicket(input);
			return currentTicket;
		},
		makeCandidate,
		acceptCandidate(candidate) {
			cm.state = candidate.applicationKind === "transaction"
				? candidate.heldTransaction.state
				: candidate.heldState;
		},
		setCmContent(content) {
			cm.state = EditorState.create({ doc: content });
		},
		setDiskContent(content) {
			diskContent = content;
			file.stat.mtime += 1;
			file.stat.size = content.length;
		},
		makePresentationRequest(candidate) {
			return Object.freeze({
				requestId: `presentation-${++requestSequence}`,
				sessionId: "session-1",
				leafId: "leaf-1",
				handoffGeneration: 1,
				switchIntentSeq: 7,
				targetPath: path,
				targetFile: file,
				candidate,
				openEditorTicket: currentTicket,
			});
		},
		makeAdmissionRequest(presentation, hostLoadTokenId = null) {
			return Object.freeze({
				requestId: `admission-${++requestSequence}`,
				reason: "open-editor-missing-target",
				sessionId: "session-1",
				leafId: "leaf-1",
				handoffGeneration: 1,
				switchIntentSeq: 7,
				targetPath: path,
				targetFile: file,
				presentation,
				hostLoadTokenId,
				openEditorTicket: currentTicket,
			});
		},
		makeHostReceipt(candidate) {
			return Object.freeze({
				receiptId: `receipt-${++requestSequence}`,
				hostLoadTokenId: candidate.hostLoadTokenId,
				switchIntentSeq: candidate.switchIntentSeq,
				sessionId: candidate.sessionId,
				leafId: candidate.leafId,
				handoffGeneration: candidate.handoffGeneration,
				targetPath: path,
				nativeHistoryEpoch: 1,
				historyResetObserved: true,
				targetSelection: candidate.proposedSelection,
				targetSelectionEpoch: 1,
				targetScrollAnchor: candidate.proposedScrollAnchor,
				targetScrollEpoch: 1,
				effectFingerprint: candidate.effectFingerprint,
			});
		},
		setAttention(value) { attention = value; },
		setTombstoned(value) { tombstoned = value; },
		setPendingRename(value) { pendingRename = value; },
		setFrontmatterBlocked(value) { frontmatterBlocked = value; },
		setActive,
		setActiveIds(fileIds) {
			activeIds = [...fileIds];
			bumpAuthority();
		},
		setOpenViews(views) { openViews = views; },
		replaceFile() {
			file = makeFile(path, diskContent, file.stat.mtime + 1);
			view.file = file;
			return file;
		},
		setStableReadHook(hook) { stableReadHook = hook; },
		setEnsureHook(hook) { ensureHook = hook; },
		setValidationHook(hook) { validationHook = hook; },
	};
}

function presentationPermitContext(
	fixture: AdmissionFixture,
	request: TargetPresentationRequest,
	plan: Extract<Awaited<ReturnType<ReconciliationController["requestTargetPresentation"]>>, { kind: "planned" }>["plan"],
): TargetPresentationPermitContext {
	return Object.freeze({
		presentationPlanId: plan.planId,
		authorityFreshnessHandleId: plan.authorityFreshnessHandleId,
		sessionId: request.sessionId,
		leafId: request.leafId,
		handoffGeneration: request.handoffGeneration,
		switchIntentSeq: request.switchIntentSeq,
		targetPath: request.targetPath,
		targetFile: request.targetFile,
		hostLoadTokenId: request.candidate.hostLoadTokenId,
		candidate: request.candidate,
		openEditorTicket: request.openEditorTicket,
	});
}

function bindContext(
	fixture: AdmissionFixture,
	token: TargetReadyToken & { targetAuthority: Extract<TargetReadyToken["targetAuthority"], { kind: "existing" }> },
	hostReceipt: HostLoadCompletionReceipt,
): BindPermitContext {
	const snapshot = fixture.ticket.views[0]!;
	const ytext = fixture.ytext;
	assert(ytext !== null, "bind context has an existing Y.Text");
	return Object.freeze({
		sessionId: token.sessionId,
		leafId: token.leafId,
		handoffGeneration: token.handoffGeneration,
		targetReadyTokenId: token.tokenId,
		targetFile: token.targetFile,
		hostLoadReceiptId: hostReceipt.receiptId,
		cm: fixture.cm,
		editorRevision: snapshot.editorRevision,
		nativeHistoryEpoch: hostReceipt.nativeHistoryEpoch,
		selectionEpoch: hostReceipt.targetSelectionEpoch,
		scrollEpoch: hostReceipt.targetScrollEpoch,
		fileId: token.targetAuthority.fileId,
		ytext,
		ytextIdentity: token.targetAuthority.ytextIdentity,
		ytextMutationEpoch: token.targetAuthority.ytextMutationEpoch,
		bindingEpoch: snapshot.bindingEpoch,
	});
}

async function completePresentation(
	fixture: AdmissionFixture,
	source: string,
	target: string,
	applicationKind: "transaction" | "state" = "transaction",
): Promise<{
	token: TargetReadyToken;
	hostReceipt: HostLoadCompletionReceipt;
}> {
	const candidate = fixture.makeCandidate(source, target, applicationKind);
	const request = fixture.makePresentationRequest(candidate);
	const planned = await fixture.controller.requestTargetPresentation(request);
	assert(planned.kind === "planned", "stable held host load receives a presentation plan");
	const permitContext = presentationPermitContext(fixture, request, planned.plan);
	assert(
		fixture.controller.consumeTargetPresentationPermit(
			planned.plan.presentationPermitId,
			permitContext,
		),
		"presentation permit is consumed once",
	);
	assert(
		!fixture.controller.consumeTargetPresentationPermit(
			planned.plan.presentationPermitId,
			permitContext,
		),
		"presentation permit cannot be reused",
	);
	fixture.acceptCandidate(candidate);
	fixture.setTicket({
		presentation: "target-candidate",
		content: target,
		pendingHostLoadTokenId: candidate.hostLoadTokenId,
		editorRevision: 10,
		selectionEpoch: 1,
		scrollEpoch: 1,
		displayedFile: makeFile("notes/A.md", source, 9),
		editorDocument: candidate.cm.state.doc,
	});
	const hostReceipt = fixture.makeHostReceipt(candidate);
	const completed = await fixture.controller.completeTargetPresentation(hostReceipt);
	assert(completed.kind === "accepted", "completed host receipt produces a target-ready token");
	return { token: completed.receipt.replacementTargetReadyToken, hostReceipt };
}

console.log("\n--- Editor authority admission: existing target and one-shot bind ---");
{
	const fixture = makeFixture({ diskContent: "same", existingContent: "same" });
	const { token, hostReceipt } = await completePresentation(fixture, "same", "same");
	assert(token.targetAuthority.kind === "existing", "same bytes alone do not block receipt-proven B");
	if (token.targetAuthority.kind === "existing") {
		const context = bindContext(fixture, token as TargetReadyToken & {
			targetAuthority: Extract<TargetReadyToken["targetAuthority"], { kind: "existing" }>;
		}, hostReceipt);
		assert(
			fixture.controller.isAuthorityFreshnessCurrent(token.authorityFreshnessHandleId, context),
			"post-presentation freshness is current for the exact context",
		);
		assert(
			fixture.controller.consumeBindPermit(token.targetAuthority.bindPermitId, context),
			"bind permit is consumed once",
		);
		assert(
			!fixture.controller.consumeBindPermit(token.targetAuthority.bindPermitId, context),
			"bind permit cannot be reused",
		);
	}
	assertEq(fixture.ensureCount, 0, "existing target presentation never seeds Y.Text");
}

console.log("\n--- Editor authority admission: exact host-owned state replacement ---");
{
	const fixture = makeFixture({ diskContent: "B", existingContent: "B" });
	const { token } = await completePresentation(fixture, "A", "B", "state");
	assert(
		token.targetAuthority.kind === "existing",
		"state-replacement candidate reaches the same existing-target authority",
	);
	assertEq(
		fixture.cm.state.doc.toString(),
		"B",
		"controller validates the exact host-owned target state document",
	);
	assertEq(fixture.ensureCount, 0, "state-replacement presentation never seeds existing Y.Text");
}

console.log("\n--- Editor authority admission: Y.Text ABA invalidates freshness ---");
{
	const fixture = makeFixture({ diskContent: "B", existingContent: "B" });
	const { token, hostReceipt } = await completePresentation(fixture, "A", "B");
	assert(token.targetAuthority.kind === "existing", "existing B produces bind authority");
	if (token.targetAuthority.kind === "existing" && fixture.ytext) {
		const context = bindContext(fixture, token as TargetReadyToken & {
			targetAuthority: Extract<TargetReadyToken["targetAuthority"], { kind: "existing" }>;
		}, hostReceipt);
		fixture.ytext.doc?.transact(() => {
			fixture.ytext?.delete(0, fixture.ytext.length);
			fixture.ytext?.insert(0, "B");
		});
		assert(
			!fixture.controller.isAuthorityFreshnessCurrent(token.authorityFreshnessHandleId, context),
			"delete-and-reinsert ABA invalidates the old freshness handle",
		);
		assert(
			!fixture.controller.consumeBindPermit(token.targetAuthority.bindPermitId, context),
			"stale ABA authority cannot consume its bind permit",
		);
	}
}

console.log("\n--- Editor authority admission: mutation epochs use bounded vault tracking ---");
{
	const fixture = makeFixture({ diskContent: "B", existingContent: "B" });
	const ytext = fixture.ytext;
	assert(ytext !== null, "bounded mutation tracker fixture has a Y.Text");
	if (ytext) {
		let directObserveCalls = 0;
		const originalObserve = ytext.observe.bind(ytext);
		Object.defineProperty(ytext, "observe", {
			configurable: true,
			value: (callback: Parameters<Y.Text["observe"]>[0]) => {
				directObserveCalls += 1;
				originalObserve(callback);
			},
		});
		const { token, hostReceipt } = await completePresentation(fixture, "A", "B");
		assertEq(
			directObserveCalls,
			0,
			"authority tracking installs no permanent per-Y.Text observer",
		);
		if (token.targetAuthority.kind === "existing") {
			const context = bindContext(fixture, token as TargetReadyToken & {
				targetAuthority: Extract<TargetReadyToken["targetAuthority"], { kind: "existing" }>;
			}, hostReceipt);
			ytext.doc?.transact(() => {
				ytext.delete(0, ytext.length);
				ytext.insert(0, "B");
			});
			assert(
				!fixture.controller.isAuthorityFreshnessCurrent(
					token.authorityFreshnessHandleId,
					context,
				),
				"vault transaction tracking still rejects same-bytes Y.Text ABA",
			);
		}
	}
}

console.log("\n--- Editor authority admission: receipt and permit halves are insufficient alone ---");
{
	const fixture = makeFixture({ diskContent: "B", existingContent: "B" });
	const candidate = fixture.makeCandidate("A", "B");
	const request = fixture.makePresentationRequest(candidate);
	const planned = await fixture.controller.requestTargetPresentation(request);
	assert(planned.kind === "planned", "two-party test receives a presentation plan");
	if (planned.kind === "planned") {
		const hostReceipt = fixture.makeHostReceipt(candidate);
		const receiptWithoutPermit = await fixture.controller.completeTargetPresentation(
			hostReceipt,
		);
		assert(
			receiptWithoutPermit.kind === "replan",
			"host completion receipt alone cannot mint target readiness",
		);
		const context = presentationPermitContext(fixture, request, planned.plan);
		assert(
			fixture.controller.consumeTargetPresentationPermit(
				planned.plan.presentationPermitId,
				context,
			),
			"the matching controller permit remains independently one-shot",
		);
		fixture.acceptCandidate(candidate);
		fixture.setTicket({
			presentation: "target-candidate",
			content: "B",
			pendingHostLoadTokenId: candidate.hostLoadTokenId,
			editorRevision: 10,
			selectionEpoch: 1,
			scrollEpoch: 1,
			editorDocument: candidate.cm.state.doc,
			displayedFile: makeFile("notes/A.md", "A", 13),
		});
		const completed = await fixture.controller.completeTargetPresentation(
			hostReceipt,
		);
		assert(
			completed.kind === "accepted",
			"the same host receipt can be revalidated after its transient replan",
		);
	}
	assertEq(fixture.ensureCount, 0, "two-party presentation proof never seeds an existing target");
}

console.log("\n--- Editor authority admission: active-set ABA invalidates freshness ---");
{
	const fixture = makeFixture({ diskContent: "B", existingContent: "B" });
	const { token, hostReceipt } = await completePresentation(fixture, "A", "B");
	assert(token.targetAuthority.kind === "existing", "existing B exposes active-set authority");
	const originalYtext = fixture.ytext;
	const originalFileId = fixture.fileId;
	if (
		token.targetAuthority.kind === "existing"
		&& originalYtext
		&& originalFileId
	) {
		const context = bindContext(fixture, token as TargetReadyToken & {
			targetAuthority: Extract<TargetReadyToken["targetAuthority"], { kind: "existing" }>;
		}, hostReceipt);
		const replacementDoc = new Y.Doc();
		const replacement = replacementDoc.getText("replacement");
		replacement.insert(0, "B");
		fixture.setActive("replacement-id", replacement);
		fixture.setActive(originalFileId, originalYtext);
		assert(
			!fixture.controller.isAuthorityFreshnessCurrent(token.authorityFreshnessHandleId, context),
			"active fileId/Y.Text replacement-and-restore ABA keeps the old handle stale",
		);
		replacementDoc.destroy();
	}
}

console.log("\n--- Editor authority admission: reset invalidates an in-flight stable read ---");
{
	const fixture = makeFixture({ diskContent: "B", existingContent: "B" });
	let markReadStarted: (() => void) | null = null;
	let releaseRead: (() => void) | null = null;
	const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
	const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
	fixture.setStableReadHook(async () => {
		markReadStarted?.();
		await readGate;
	});
	const candidate = fixture.makeCandidate("A", "B");
	const pending = fixture.controller.requestTargetPresentation(
		fixture.makePresentationRequest(candidate),
	);
	await readStarted;
	fixture.controller.reset();
	releaseRead?.();
	const result = await pending;
	assert(
		result.kind === "replan" && result.reason === "authority-changed",
		"pre-reset request cannot mint a post-reset presentation permit",
	);
	assertEq(fixture.ensureCount, 0, "reset race performs no Y.Text seed");
}

console.log("\n--- Editor authority admission: missing target seeds only on second pass ---");
{
	const fixture = makeFixture({
		diskContent: "local-B",
		existingContent: null,
		remoteProjectionAllowed: false,
	});
	const admissionInternals = fixture.controller as unknown as {
		getMarkdownDiskRevision(path: string): number;
	};
	const diskRevisionBefore = admissionInternals.getMarkdownDiskRevision(fixture.path);
	const { token } = await completePresentation(fixture, "source-A", "local-B");
	assert(token.targetAuthority.kind === "missing", "presentation proves missing B without creating it");
	assertEq(fixture.ensureCount, 0, "presentation pass performs zero ensureFile mutations");
	fixture.setTicket({ presentation: "target-proven", content: "local-B", editorRevision: 11 });
	const admission = await fixture.controller.requestOpenPathAdmission(
		fixture.makeAdmissionRequest("target-proven"),
	);
	assert(admission.kind === "seed-required", "target-proven missing B receives a seed plan");
	assertEq(fixture.ensureCount, 0, "planning the seed is read-only");
	if (admission.kind === "seed-required") {
		const seeded = await fixture.controller.seedMissingTarget(admission.plan);
		assert(seeded.kind === "seeded", "certified local B base is seeded while projection is closed");
		assertEq(fixture.ensureCount, 1, "seed permit authorizes exactly one ensureFile call");
		const repeated = await fixture.controller.seedMissingTarget(admission.plan);
		assert(repeated.kind !== "seeded", "seed plan cannot be reused");
		assertEq(fixture.ensureCount, 1, "reused seed plan performs no second mutation");
	}
	assertEq(
		admissionInternals.getMarkdownDiskRevision(fixture.path),
		diskRevisionBefore,
		"open-path request and seed do not fabricate a vault disk event revision",
	);
}

console.log("\n--- Editor authority admission: provider-created target wins before seed ---");
{
	const fixture = makeFixture({ diskContent: "provider-B", existingContent: null });
	await completePresentation(fixture, "source-A", "provider-B");
	fixture.setTicket({
		presentation: "target-proven",
		content: "provider-B",
		editorRevision: 12,
	});
	const providerDoc = new Y.Doc();
	const providerText = providerDoc.getText("provider-created-B");
	providerText.insert(0, "provider-B");
	fixture.setActive("provider-created-id", providerText);
	const admission = await fixture.controller.requestOpenPathAdmission(
		fixture.makeAdmissionRequest("target-proven"),
	);
	assert(
		admission.kind === "existing"
			&& admission.targetReadyToken.targetAuthority.kind === "existing",
		"fresh provider-created exact B is re-proven instead of overwritten",
	);
	assertEq(fixture.ensureCount, 0, "provider-created B performs no ensureFile seed");
	providerDoc.destroy();
}

console.log("\n--- Editor authority admission: target-proven autosave seeds the current B successor ---");
{
	const base = "presented B base";
	const successor = "presented B base plus local input";
	const fixture = makeFixture({ diskContent: base, existingContent: null });
	const { hostReceipt } = await completePresentation(fixture, "source A", base);
	fixture.setCmContent(successor);
	fixture.setDiskContent(successor);
	fixture.setTicket({
		presentation: "target-proven",
		content: successor,
		editorRevision: 12,
		editorDocument: fixture.cm.state.doc,
	});
	const admission = await fixture.controller.requestOpenPathAdmission(
		fixture.makeAdmissionRequest("target-proven"),
	);
	assert(
		admission.kind === "seed-required",
		"a disk-settled successor receives a fresh seed plan after target presentation",
	);
	if (admission.kind === "seed-required") {
		const seeded = await fixture.controller.seedMissingTarget(admission.plan);
		assert(seeded.kind === "seeded", "the exact autosaved B successor is seeded and re-proven");
		if (seeded.kind === "seeded") {
			assertEq(
				seeded.receipt.replacementTargetReadyToken.certifiedBaseContent,
				successor,
				"replacement bind authority certifies the current B successor",
			);
			assertEq(
				seeded.receipt.replacementTargetReadyToken.hostLoadReceiptId,
				hostReceipt.receiptId,
				"successor authority retains the original target-presentation lineage",
			);
		}
	}
	assertEq(fixture.ensureCount, 1, "autosaved successor uses one controller-owned seed");
}

console.log("\n--- Editor authority admission: post-seed supersession wins final publication ---");
{
	const fixture = makeFixture({ diskContent: "B", existingContent: null });
	await completePresentation(fixture, "A", "B");
	fixture.setTicket({ presentation: "target-proven", content: "B", editorRevision: 18 });
	const admission = await fixture.controller.requestOpenPathAdmission(
		fixture.makeAdmissionRequest("target-proven"),
	);
	assert(admission.kind === "seed-required", "supersession fixture receives a seed plan");
	if (admission.kind === "seed-required") {
		type ReadyRecord = Readonly<{
			token: TargetReadyToken;
			context: unknown;
			snapshot: unknown;
			hostReceipt: HostLoadCompletionReceipt;
			candidate: PendingHostLoadCandidate;
		}>;
		const internals = fixture.controller as unknown as {
			targetReadyBySession: Map<string, ReadyRecord>;
		};
		let successorEntry: readonly [string, ReadyRecord] | null = null;
		const publishSuccessor = (): void => {
			const currentEntry = internals.targetReadyBySession.entries().next().value as
				| [string, ReadyRecord]
				| undefined;
			assert(currentEntry !== undefined, "validation reentry sees the current ready anchor");
			if (!currentEntry) return;
			const successor = Object.freeze({
				...currentEntry[1],
				token: Object.freeze({
					...currentEntry[1].token,
					tokenId: `${currentEntry[1].token.tokenId}-successor`,
				}),
			});
			internals.targetReadyBySession.set(currentEntry[0], successor);
			successorEntry = Object.freeze([currentEntry[0], successor] as const);
		};
		fixture.setEnsureHook(() => {
			let postSeedValidationCount = 0;
			fixture.setValidationHook(() => {
				postSeedValidationCount += 1;
				if (postSeedValidationCount === 2) publishSuccessor();
			});
		});
		const result = await fixture.controller.seedMissingTarget(admission.plan);
		assert(
			result.kind === "replan" && result.reason === "authority-changed",
			"a successor published during final validation rejects the stale seed completion",
		);
		assert(
			successorEntry !== null
				&& internals.targetReadyBySession.get(successorEntry[0]) === successorEntry[1],
			"stale seed completion cannot overwrite the reentrant successor",
		);
	}
}

console.log("\n--- Editor authority admission: healthy active target wins a stale tombstone ---");
{
	const fixture = makeFixture({
		diskContent: "B",
		existingContent: "B",
		tombstoned: true,
	});
	const candidate = fixture.makeCandidate("A", "B");
	const request = fixture.makePresentationRequest(candidate);
	const planned = await fixture.controller.requestTargetPresentation(request);
	assert(
		planned.kind === "planned",
		"a stale tombstone cannot hide an exact healthy active B authority",
	);
	if (planned.kind === "planned") {
		assert(
			fixture.controller.consumeTargetPresentationPermit(
				planned.plan.presentationPermitId,
				presentationPermitContext(fixture, request, planned.plan),
			),
			"stale-tombstone presentation permit remains consumable",
		);
		fixture.acceptCandidate(candidate);
		fixture.setTicket({
			presentation: "target-candidate",
			content: "B",
			pendingHostLoadTokenId: candidate.hostLoadTokenId,
			editorRevision: 10,
			selectionEpoch: 1,
			scrollEpoch: 1,
			displayedFile: makeFile("notes/A.md", "A", 14),
			editorDocument: candidate.cm.state.doc,
		});
		const completed = await fixture.controller.completeTargetPresentation(
			fixture.makeHostReceipt(candidate),
		);
		assert(
			completed.kind === "accepted"
				&& completed.receipt.replacementTargetReadyToken.targetAuthority.kind === "existing",
			"stale tombstone does not invalidate the completed existing-target proof",
		);
	}
	assertEq(fixture.ensureCount, 0, "stale-tombstone existing authority performs no seed");
}

console.log("\n--- Editor authority admission: presentation revision is exact ---");
{
	const fixture = makeFixture({ diskContent: "B", existingContent: "B" });
	const candidate = fixture.makeCandidate("A", "B");
	const revisionDriftedCandidate = Object.freeze({
		...candidate,
		editorRevisionBefore: candidate.editorRevisionBefore + 1,
	});
	const result = await fixture.controller.requestTargetPresentation(
		fixture.makePresentationRequest(revisionDriftedCandidate),
	);
	assert(
		result.kind === "replan" && result.reason === "presentation-changed",
		"a candidate captured at another CM revision cannot mint a presentation permit",
	);
	const missingRetirementReceipt = Object.freeze({
		...candidate,
		sourceUnloadReceiptId: "",
	});
	const missingReceiptResult = await fixture.controller.requestTargetPresentation(
		fixture.makePresentationRequest(missingRetirementReceipt),
	);
	assert(
		missingReceiptResult.kind === "replan"
			&& missingReceiptResult.reason === "presentation-changed",
		"a candidate without a source-retirement receipt cannot mint a presentation permit",
	);
}

console.log("\n--- Editor authority admission: pending rename stays outside open-path admission ---");
{
	const fixture = makeFixture({
		diskContent: "B",
		existingContent: "B",
		pendingRename: true,
	});
	const candidate = fixture.makeCandidate("A", "B");
	const result = await fixture.controller.requestTargetPresentation(
		fixture.makePresentationRequest(candidate),
	);
	assert(
		result.kind === "deferred" && result.reason === "authority-blocked",
		"pending rename must settle before open-path presentation can mint authority",
	);
	assertEq(fixture.ensureCount, 0, "pending rename performs no open-path seed");
}

console.log("\n--- Editor authority admission: pending rename invalidates captured freshness ---");
{
	const fixture = makeFixture({ diskContent: "B", existingContent: "B" });
	const candidate = fixture.makeCandidate("A", "B");
	const request = fixture.makePresentationRequest(candidate);
	const planned = await fixture.controller.requestTargetPresentation(request);
	assert(planned.kind === "planned", "pre-rename target receives a presentation plan");
	if (planned.kind === "planned") {
		fixture.setPendingRename(true);
		assert(
			!fixture.controller.consumeTargetPresentationPermit(
				planned.plan.presentationPermitId,
				presentationPermitContext(fixture, request, planned.plan),
			),
			"a rename that starts after capture invalidates the presentation permit",
		);
	}
	assertEq(fixture.ensureCount, 0, "post-capture rename performs no open-path seed");
}

console.log("\n--- Editor authority admission: stale unconsumed presentation plan is replaceable ---");
{
	const fixture = makeFixture({ diskContent: "B", existingContent: "B" });
	const candidate = fixture.makeCandidate("A", "B");
	const firstRequest = fixture.makePresentationRequest(candidate);
	const first = await fixture.controller.requestTargetPresentation(firstRequest);
	assert(first.kind === "planned", "initial editor ticket receives a presentation plan");
	if (first.kind === "planned") {
		const initialView = fixture.ticket.views[0]!;
		fixture.setTicket({
			presentation: "target-candidate",
			content: initialView.editorContent,
			pendingHostLoadTokenId: candidate.hostLoadTokenId,
			displayedFile: initialView.displayedFile,
			displayedPath: initialView.displayedPath,
			editorRevision: initialView.editorRevision,
			selectionEpoch: initialView.selectionEpoch,
			scrollEpoch: initialView.scrollEpoch,
			editorDocument: initialView.editorDocument,
		});
		const secondRequest = fixture.makePresentationRequest(candidate);
		const second = await fixture.controller.requestTargetPresentation(secondRequest);
		assert(
			second.kind === "planned" && second.plan.planId !== first.plan.planId,
			"a fresh exact ticket replaces only the stale unconsumed plan",
		);
		assert(
			!fixture.controller.consumeTargetPresentationPermit(
				first.plan.presentationPermitId,
				presentationPermitContext(fixture, firstRequest, first.plan),
			),
			"retiring an unconsumed plan permanently invalidates its old permit",
		);
		if (second.kind === "planned") {
			assert(
				fixture.controller.consumeTargetPresentationPermit(
					second.plan.presentationPermitId,
					presentationPermitContext(fixture, secondRequest, second.plan),
				),
				"the replacement plan owns one fresh consumable permit",
			);
		}
	}
}

console.log("\n--- Editor authority admission: policy and lineage blockers fail closed ---");
{
	const sourceFixture = makeFixture({ diskContent: "B" });
	sourceFixture.setTicket({
		presentation: "source",
		content: "B",
		displayedFile: makeFile("notes/A.md", "B", 12),
	});
	const sourceResult = await sourceFixture.controller.requestOpenPathAdmission(
		sourceFixture.makeAdmissionRequest("source"),
	);
	assert(
		sourceResult.kind === "deferred" && sourceResult.reason === "transitioning",
		"source presentation cannot seed equal target bytes",
	);
	assertEq(sourceFixture.ensureCount, 0, "source presentation makes no mutation");

	const attentionFixture = makeFixture({ diskContent: "B" });
	await completePresentation(attentionFixture, "A", "B");
	attentionFixture.setTicket({ presentation: "target-proven", content: "B" });
	attentionFixture.setAttention(true);
	const attentionResult = await attentionFixture.controller.requestOpenPathAdmission(
		attentionFixture.makeAdmissionRequest("target-proven"),
	);
	assert(
		attentionResult.kind === "deferred" && attentionResult.reason === "attention",
		"Attention blocks open-path admission",
	);

	const tombstoneFixture = makeFixture({ diskContent: "B" });
	await completePresentation(tombstoneFixture, "A", "B");
	tombstoneFixture.setTicket({ presentation: "target-proven", content: "B" });
	tombstoneFixture.setTombstoned(true);
	const tombstoneResult = await tombstoneFixture.controller.requestOpenPathAdmission(
		tombstoneFixture.makeAdmissionRequest("target-proven"),
	);
	assert(
		tombstoneResult.kind === "deferred" && tombstoneResult.reason === "tombstone",
		"open-path admission never revives a tombstone",
	);

	const frontmatterFixture = makeFixture({ diskContent: "B" });
	await completePresentation(frontmatterFixture, "A", "B");
	frontmatterFixture.setTicket({ presentation: "target-proven", content: "B" });
	frontmatterFixture.setFrontmatterBlocked(true);
	const frontmatterResult = await frontmatterFixture.controller.requestOpenPathAdmission(
		frontmatterFixture.makeAdmissionRequest("target-proven"),
	);
	assert(
		frontmatterResult.kind === "deferred" && frontmatterResult.reason === "frontmatter",
		"frontmatter policy blocks open-path admission",
	);
}

console.log("\n--- Editor authority admission: collisions, panes, and TFile races replan ---");
{
	const collisionFixture = makeFixture({ diskContent: "B" });
	await completePresentation(collisionFixture, "A", "B");
	collisionFixture.setTicket({ presentation: "target-proven", content: "B" });
	const text1 = new Y.Doc().getText("one");
	text1.insert(0, "B");
	collisionFixture.setActive("one", text1);
	// A provider collision is represented by a second metadata identity. The
	// controller must observe the exact active set, not merely getTextForPath().
	collisionFixture.setActiveIds(["one", "two"]);
	const collision = await collisionFixture.controller.requestOpenPathAdmission(
		collisionFixture.makeAdmissionRequest("target-proven"),
	);
	assert(
		collision.kind === "deferred" && collision.reason === "multiple-authorities",
		"active fileId collision blocks admission",
	);

	const paneFixture = makeFixture({ diskContent: "B" });
	await completePresentation(paneFixture, "A", "B");
	paneFixture.setTicket({ presentation: "target-proven", content: "B" });
	const secondView = Object.assign(new MarkdownView(), {
		file: paneFixture.file,
		leaf: { id: "leaf-2" },
		editor: { getValue: () => "different" },
	}) as MutableMarkdownView;
	paneFixture.setOpenViews([paneFixture.view, secondView]);
	const paneResult = await paneFixture.controller.requestOpenPathAdmission(
		paneFixture.makeAdmissionRequest("target-proven"),
	);
	assert(
		paneResult.kind === "deferred" && paneResult.reason === "multiple-authorities",
		"an additional un-ticketed pane blocks admission",
	);

	const fileRaceFixture = makeFixture({ diskContent: "B" });
	fileRaceFixture.setStableReadHook(async () => {
		fileRaceFixture.replaceFile();
	});
	const raced = await fileRaceFixture.controller.requestOpenPathAdmission(
		fileRaceFixture.makeAdmissionRequest("target-proven"),
	);
	assert(
		raced.kind === "replan" && raced.reason === "authority-changed",
		"TFile replacement during stable read replans without mutation",
	);
	assertEq(fileRaceFixture.ensureCount, 0, "TFile race performs no ensureFile mutation");
}

console.log(`\nEditor authority admission: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
