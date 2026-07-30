import { EditorSelection, EditorState, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import {
	ReconciliationController,
	type StableMarkdownReadResult,
} from "../src/runtime/reconciliationController";
import type {
	AuthorityFreshnessContext,
	HandoffReplayRecoveryAdmissionEvidence,
	HandoffReplayRecoveryClaim,
	HandoffReplayRecoveryOpenEditorMutationTicket,
	HandoffReplayRecoveryOpenEditorMutationViewTicket,
	OpenPathAdmissionRequest,
} from "../src/runtime/editorAuthorityAdmission";
import type {
	OpenEditorMutationTicket,
} from "../src/sync/editorBinding";
import type {
	HostLoadCompletionReceipt,
	PendingHostLoadCandidate,
	TargetReadyToken,
} from "../src/sync/editorHandoffState";
import type { HandoffReplayTargetSnapshot } from "../src/sync/editorHandoffReplay";
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

type RecoveryClaim = HandoffReplayRecoveryClaim;
type RecoveryTicketEvidence = HandoffReplayRecoveryAdmissionEvidence;
type RecoveryViewTicket = HandoffReplayRecoveryOpenEditorMutationViewTicket;
type RecoveryTicket = HandoffReplayRecoveryOpenEditorMutationTicket;
type RecoveryAdmissionRequest = Extract<
	OpenPathAdmissionRequest,
	{ reason: "handoff-replay-target-bind" }
>;

type RecoverySnapshot = HandoffReplayTargetSnapshot;

type RecoveryOwnerProof = Readonly<{
	claim: RecoveryClaim;
	recoveryOperationEpoch: number;
	expectedGeneration: number;
	targetReadyToken: TargetReadyToken | null;
	inputGateInstalled: boolean;
	saveGuardInstalled: boolean;
	intentStateKind: "stored" | "replay-pending";
}>;

interface Fixture {
	readonly path: string;
	readonly base: string;
	readonly file: MutableTFile;
	readonly view: MutableMarkdownView;
	readonly cm: EditorView;
	readonly ytext: Y.Text | null;
	readonly claim: RecoveryClaim;
	readonly hostReceipt: HostLoadCompletionReceipt;
	readonly controller: ReconciliationController;
	readonly ensureContents: readonly string[];
	get ticket(): RecoveryTicket;
	get postBindSnapshot(): RecoverySnapshot | null;
	setPostBindSnapshot(snapshot: RecoverySnapshot | null): void;
	setRecoveryOwnerProof(overrides: Partial<RecoveryOwnerProof>): void;
	makeTicket(overrides?: Partial<{
		recoveryClaim: RecoveryClaim;
		recoveryTargetBindingRequest: RecoveryClaim | null;
		inputGateInstalled: boolean;
		saveGuardInstalled: boolean;
		intentStateKind: "stored" | "replay-pending";
		intentId: string;
		recordId: string;
		handoffGeneration: number;
		cm: EditorView;
		binding:
			| Readonly<{ kind: "unbound"; bindingEpoch: number }>
			| Readonly<{
				kind: "bound";
				path: string;
				fileId: string;
				ytext: Y.Text;
				bindingEpoch: number;
			}>;
		editorDocument: Text;
	}>): RecoveryTicket;
	setTicket(ticket: RecoveryTicket): void;
	makeRecoveryRequest(overrides?: Partial<{
		recoveryClaim: RecoveryClaim;
		handoffGeneration: number;
		openEditorTicket: RecoveryTicket;
	}>): RecoveryAdmissionRequest;
	makeNormalRequest(): OpenPathAdmissionRequest;
	makeFreshnessContext(token: TargetReadyToken): AuthorityFreshnessContext;
	makePostBindSnapshot(
		token: TargetReadyToken,
		overrides?: Partial<RecoverySnapshot>,
	): RecoverySnapshot;
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

function makeFixture(options: Readonly<{ missingTarget?: boolean }> = {}): Fixture {
	const path = "notes/B.md";
	const base = "certified B base";
	const file = makeFile(path, base);
	const cm = {
		state: EditorState.create({
			doc: base,
			selection: EditorSelection.cursor(0),
		}),
	} as unknown as EditorView;
	const view = Object.assign(new MarkdownView(), {
		file,
		leaf: { id: "leaf-B" },
		editor: { getValue: () => currentTicket.views[0]?.editorContent ?? "" },
	}) as MutableMarkdownView;
	const claim: RecoveryClaim = Object.freeze({
		recoveryOperationEpoch: 5,
		intentId: "intent-B",
		recordId: "record-B",
	});
	const ydoc = new Y.Doc();
	let activeYtext: Y.Text | null = null;
	let activeFileId: string | null = null;
	let activeIds: string[] = [];
	if (!options.missingTarget) {
		activeYtext = ydoc.getText("B");
		activeYtext.insert(0, base);
		activeFileId = "file-B";
		activeIds = [activeFileId];
	}
	const ensureContents: string[] = [];
	let ticketSequence = 0;

	const makeTicket: Fixture["makeTicket"] = (overrides = {}) => {
		const ticketClaim = overrides.recoveryClaim ?? claim;
		const intentStateKind = overrides.intentStateKind ?? "stored";
		const intentId = overrides.intentId ?? ticketClaim.intentId;
		const recordId = overrides.recordId ?? ticketClaim.recordId;
		const handoffGeneration = overrides.handoffGeneration ?? 3;
		const ticketCm = overrides.cm ?? cm;
		const binding = overrides.binding ?? Object.freeze({
			kind: "unbound" as const,
			bindingEpoch: 10,
		});
		const evidence: RecoveryTicketEvidence = Object.freeze({
			purpose: "handoff-replay-target-bind",
			recoveryClaim: ticketClaim,
			recoveryTargetBindingRequest:
				overrides.recoveryTargetBindingRequest === undefined
					? ticketClaim
					: overrides.recoveryTargetBindingRequest,
			inputGateInstalled: overrides.inputGateInstalled ?? true,
			saveGuardInstalled: overrides.saveGuardInstalled ?? false,
			pendingHostLoadCandidate: null,
			intentState: Object.freeze({
				kind: intentStateKind,
				intentId,
				recordId,
			}),
			binding,
		});
		const primary: RecoveryViewTicket = Object.freeze({
			bootSessionId: "boot-1",
			sessionId: "session-B",
			handoffGeneration,
			displayedFile: file,
			displayedPath: path,
			targetFile: file,
			stableTargetIdentityProven: true,
			switchIntentSeq: 17,
			nativeHistoryEpoch: 2,
			selectionEpoch: 4,
			scrollEpoch: 6,
			handoffPresentation: "target-proven",
			handoffPhase:
				intentStateKind === "stored"
					? "awaiting-recovery-commit"
					: "awaiting-replay-settlement",
			intentStateKind,
			pendingHostLoadTokenId: null,
			view,
			viewId: "view-B",
			leafId: "leaf-B",
			cm: ticketCm,
			cmId: "cm-B",
			bindingEpoch: binding.bindingEpoch,
			editorRevision: 8,
			editorAuthorityRevision: 0,
			editorAuthorityContent: null,
			editorDocument: overrides.editorDocument ?? ticketCm.state.doc,
			editorContent: base,
			handoffReplayRecovery: evidence,
		});
		ticketSequence += 1;
		return Object.freeze({
			path,
			views: Object.freeze([primary]),
			testSequence: ticketSequence,
		}) as RecoveryTicket;
	};

	let currentTicket = makeTicket();
	let postBindSnapshot: RecoverySnapshot | null = null;
	let recoveryOwnerProof: RecoveryOwnerProof = Object.freeze({
		claim,
		recoveryOperationEpoch: claim.recoveryOperationEpoch,
		expectedGeneration: 3,
		targetReadyToken: null,
		inputGateInstalled: true,
		saveGuardInstalled: false,
		intentStateKind: "stored",
	});
	const hostReceipt: HostLoadCompletionReceipt = Object.freeze({
		receiptId: "host-receipt-B",
		hostLoadTokenId: "host-load-B",
		switchIntentSeq: 17,
		sessionId: "session-B",
		leafId: "leaf-B",
		handoffGeneration: 3,
		targetPath: path,
		nativeHistoryEpoch: 2,
		historyResetObserved: true,
		targetSelection: cm.state.selection,
		targetSelectionEpoch: 4,
		targetScrollAnchor: 0,
		targetScrollEpoch: 6,
		effectFingerprint: "effect-B",
	});
	const candidateState = EditorState.create({ doc: "source A" });
	const heldTransaction = candidateState.update({
		changes: {
			from: 0,
			to: candidateState.doc.length,
			insert: base,
		},
		selection: EditorSelection.cursor(0),
	});
	const candidate: PendingHostLoadCandidate = Object.freeze({
		hostLoadTokenId: hostReceipt.hostLoadTokenId,
		hostLoadCompletedEpoch: hostReceipt.nativeHistoryEpoch,
		switchIntentSeq: 17,
		sessionId: "session-B",
		leafId: "leaf-B",
		handoffGeneration: 3,
		targetPathAtDispatch: path,
		cm,
		runtimeView: view as never,
		startDocument: candidateState.doc,
		targetDocument: heldTransaction.newDoc,
		incomingContent: base,
		applicationKind: "transaction",
		heldTransaction,
		heldState: null,
		hostSetViewDataClear: true,
		nativeHistoryEpochBefore: 1,
		proposedSelection: hostReceipt.targetSelection,
		proposedScrollAnchor: hostReceipt.targetScrollAnchor,
		effectFingerprint: hostReceipt.effectFingerprint,
		runtimeViewDataBefore: "source A",
		bindingEpoch: 10,
		editorRevisionBefore: 7,
	});

	const stableRead = async (): Promise<StableMarkdownReadResult> => ({
		kind: "ready",
		file,
		content: base,
		stat: { mtime: file.stat.mtime, size: file.stat.size },
	});
	const vaultSync = {
		ydoc,
		getActiveFileIdsForPath: (candidatePath: string) =>
			candidatePath === path ? [...activeIds] : [],
		getTextForPath: (candidatePath: string) =>
			candidatePath === path ? activeYtext : null,
		getFileId: (candidatePath: string) =>
			candidatePath === path ? (activeFileId ?? undefined) : undefined,
		getFileIdForText: (candidateText: Y.Text) =>
			candidateText === activeYtext ? (activeFileId ?? undefined) : undefined,
		isMarkdownTombstoned: () => false,
		isPendingRenameTarget: () => false,
		ensureFile: (
			candidatePath: string,
			content: string,
			_deviceName: string,
			ensureOptions?: Readonly<{ canCreate?: () => boolean }>,
		): EnsureFileResult => {
			ensureContents.push(content);
			if (candidatePath !== path || ensureOptions?.canCreate?.() === false) {
				return { kind: "blocked", reason: "policy" };
			}
			if (activeYtext && activeFileId) {
				return { kind: "existing", fileId: activeFileId, ytext: activeYtext };
			}
			activeFileId = "seeded-file-B";
			activeYtext = ydoc.getText("seeded-B");
			activeIds = [activeFileId];
			activeYtext.insert(0, content);
			return { kind: "created", fileId: activeFileId, ytext: activeYtext };
		},
	} as unknown as VaultSync;

	const editorBindings = {
		captureOpenEditorMutationTicket: () => currentTicket,
		validateOpenEditorMutationTicket: (
			candidateTicket: OpenEditorMutationTicket,
			openViews: readonly MarkdownView[],
		) => candidateTicket === currentTicket && openViews.length === 1
			? { current: true as const }
			: { current: false as const, reason: "binding-epoch-changed" as const },
		captureHandoffReplayTargetSnapshot: (rawRequest: Readonly<{
			sessionId: string;
			expectedGeneration: number;
			recoveryOperationEpoch: number;
			recoveryClaim?: Readonly<{ intentId: string; recordId: string }>;
			targetReadyToken: TargetReadyToken;
		}>) => {
			const requestClaim = rawRequest.recoveryClaim;
			const ownerClaim = recoveryOwnerProof.claim;
			if (
				!postBindSnapshot
				|| !requestClaim
				|| requestClaim.intentId !== ownerClaim.intentId
				|| requestClaim.recordId !== ownerClaim.recordId
				|| rawRequest.recoveryOperationEpoch
					!== recoveryOwnerProof.recoveryOperationEpoch
				|| rawRequest.expectedGeneration !== recoveryOwnerProof.expectedGeneration
				|| rawRequest.targetReadyToken !== recoveryOwnerProof.targetReadyToken
				|| !recoveryOwnerProof.inputGateInstalled
				|| recoveryOwnerProof.saveGuardInstalled
				|| (
					recoveryOwnerProof.intentStateKind !== "stored"
					&& recoveryOwnerProof.intentStateKind !== "replay-pending"
				)
			) {
				return { kind: "not-ready" as const, reason: "target-not-proven" as const };
			}
			return { kind: "ready" as const, snapshot: postBindSnapshot };
		},
	};
	const app = {
		vault: {
			getAbstractFileByPath: (candidatePath: string) =>
				candidatePath === path ? file : null,
			read: async () => base,
			adapter: {
				stat: async () => ({ mtime: file.stat.mtime, size: file.stat.size }),
			},
		},
		workspace: {
			activeLeaf: { view },
			getActiveViewOfType: () => view,
			iterateAllLeaves: (callback: (leaf: { view: MarkdownView }) => void) => {
				callback({ view });
			},
		},
	};
	const controller = new ReconciliationController({
		app,
		getSettings: () => ({ deviceName: "test-device" }),
		getRuntimeConfig: () => ({}),
		getVaultSync: () => vaultSync,
		getDiskMirror: () => ({
			isPreservedUnresolved: () => false,
			getPreservedUnresolvedEntries: () => [],
		}),
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
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		readStableMarkdownFile: stableRead,
	} as never);

	const anchorToken: TargetReadyToken = Object.freeze({
		tokenId: "presentation-token-B",
		sessionId: "session-B",
		authorityFreshnessHandleId: "presentation-freshness-B",
		authorityFingerprint: "presentation-fingerprint-B",
		controllerLifecycleGeneration: 0,
		leafId: "leaf-B",
		handoffGeneration: 3,
		switchIntentSeq: 17,
		targetPath: path,
		targetFile: file,
		targetAuthority: activeYtext && activeFileId
			? Object.freeze({
				kind: "existing" as const,
				fileId: activeFileId,
				ytextIdentity: "presentation-ytext-B",
				ytextMutationEpoch: 0,
				bindPermitId: "presentation-bind-B",
			})
			: Object.freeze({
				kind: "missing" as const,
				activeIdSetEpoch: 0,
			}),
		hostLoadTokenId: hostReceipt.hostLoadTokenId,
		hostLoadCompletedEpoch: hostReceipt.nativeHistoryEpoch,
		hostLoadReceiptId: hostReceipt.receiptId,
		nativeHistoryEpoch: hostReceipt.nativeHistoryEpoch,
		targetSelectionEpoch: hostReceipt.targetSelectionEpoch,
		targetScrollEpoch: hostReceipt.targetScrollEpoch,
		certifiedBaseContent: base,
		certifiedBaseHash: "presentation-base-hash",
		openEditorTicketId: "presentation-ticket-B",
	});
	const internals = controller as unknown as {
		targetReadyBySession: Map<string, unknown>;
	};
	internals.targetReadyBySession.set(
		JSON.stringify(["session-B", "leaf-B", 3, path]),
		Object.freeze({
			token: anchorToken,
			context: Object.freeze({}),
			snapshot: Object.freeze({}),
			hostReceipt,
			candidate,
		}),
	);

	const makeRecoveryRequest: Fixture["makeRecoveryRequest"] = (overrides = {}) => ({
		requestId: `recovery-admission-${++ticketSequence}`,
		reason: "handoff-replay-target-bind",
		recoveryClaim: overrides.recoveryClaim ?? claim,
		sessionId: "session-B",
		leafId: "leaf-B",
		handoffGeneration: overrides.handoffGeneration ?? 3,
		switchIntentSeq: 17,
		targetPath: path,
		targetFile: file,
		presentation: "target-proven",
		hostLoadTokenId: null,
		openEditorTicket: overrides.openEditorTicket ?? currentTicket,
	}) as RecoveryAdmissionRequest;
	const makeNormalRequest = (): OpenPathAdmissionRequest => ({
		...makeRecoveryRequest(),
		requestId: `normal-admission-${++ticketSequence}`,
		reason: "open-editor-missing-target",
		recoveryClaim: undefined,
	}) as unknown as OpenPathAdmissionRequest;
	const makeFreshnessContext = (token: TargetReadyToken): AuthorityFreshnessContext =>
		Object.freeze({
			sessionId: token.sessionId,
			leafId: token.leafId,
			handoffGeneration: token.handoffGeneration,
			targetReadyTokenId: token.tokenId,
			targetFile: token.targetFile,
			hostLoadReceiptId: token.hostLoadReceiptId,
			cm,
			editorRevision: 8,
			nativeHistoryEpoch: hostReceipt.nativeHistoryEpoch,
			selectionEpoch: hostReceipt.targetSelectionEpoch,
			scrollEpoch: hostReceipt.targetScrollEpoch,
		});
	const makePostBindSnapshot: Fixture["makePostBindSnapshot"] = (token, overrides = {}) => {
		assert(
			token.targetAuthority.kind === "existing",
			"post-bind fixture requires existing target authority",
		);
		const authority = token.targetAuthority;
		return Object.freeze({
			sessionId: token.sessionId,
			leafId: token.leafId,
			handoffGeneration: token.handoffGeneration,
			recoveryOperationEpoch: claim.recoveryOperationEpoch,
			targetReadyTokenId: token.tokenId,
			hostLoadTokenId: token.hostLoadTokenId,
			hostLoadReceiptId: token.hostLoadReceiptId,
			targetPath: token.targetPath,
			targetFile: token.targetFile,
			targetFileId: authority.fileId,
			cm,
			ytext: activeYtext!,
			ytextIdentity: authority.ytextIdentity,
			ytextMutationEpoch: authority.ytextMutationEpoch,
			bindingEpoch: 11,
			editorRevision: 8,
			nativeHistoryEpoch: hostReceipt.nativeHistoryEpoch,
			selectionEpoch: hostReceipt.targetSelectionEpoch,
			scrollEpoch: hostReceipt.targetScrollEpoch,
			selection: hostReceipt.targetSelection,
			scrollAnchor: hostReceipt.targetScrollAnchor,
			cmDocument: cm.state.doc,
			editorFacadeContent: base,
			runtimeCacheContent: base,
			ytextContent: base,
			...overrides,
		});
	};

	return {
		path,
		base,
		file,
		view,
		cm,
		ytext: activeYtext,
		claim,
		hostReceipt,
		controller,
		ensureContents,
		get ticket() {
			return currentTicket;
		},
		get postBindSnapshot() {
			return postBindSnapshot;
		},
		setPostBindSnapshot(snapshot) {
			postBindSnapshot = snapshot;
		},
		setRecoveryOwnerProof(overrides) {
			recoveryOwnerProof = Object.freeze({
				...recoveryOwnerProof,
				...overrides,
			});
		},
		makeTicket,
		setTicket(ticket) {
			currentTicket = ticket;
		},
		makeRecoveryRequest,
		makeNormalRequest,
		makeFreshnessContext,
		makePostBindSnapshot,
	};
}

async function expectRecoveryRejected(
	message: string,
	mutate: (fixture: Fixture) => RecoveryAdmissionRequest,
): Promise<void> {
	const fixture = makeFixture();
	const result = await fixture.controller.requestOpenPathAdmission(mutate(fixture));
	assert(result.kind !== "existing" && result.kind !== "seed-required", message);
}

console.log("\n--- Recovery admission: normal unresolved path remains closed ---");
{
	const fixture = makeFixture();
	const result = await fixture.controller.requestOpenPathAdmission(fixture.makeNormalRequest());
	assert(
		result.kind === "deferred" && result.reason === "transitioning",
		"normal open-path admission cannot bind a gated stored recovery",
	);
}

console.log("\n--- Recovery admission: exact stored claim admits B only ---");
{
	const fixture = makeFixture();
	const result = await fixture.controller.requestOpenPathAdmission(
		fixture.makeRecoveryRequest(),
	);
	assert(
		result.kind === "existing"
			&& result.targetReadyToken.targetAuthority.kind === "existing",
		"recovery purpose accepts the exact stored claim and existing B authority",
	);
	if (result.kind === "existing") {
		assertEq(
			result.targetReadyToken.certifiedBaseContent,
			fixture.base,
			"recovery token certifies B base rather than quarantined successor",
		);
	}
}

console.log("\n--- Recovery admission: one-field pre-bind mismatches fail closed ---");
await expectRecoveryRejected("wrong intent is rejected", (fixture) =>
	fixture.makeRecoveryRequest({
		recoveryClaim: Object.freeze({ ...fixture.claim, intentId: "intent-other" }),
	}));
await expectRecoveryRejected("wrong record is rejected", (fixture) =>
	fixture.makeRecoveryRequest({
		recoveryClaim: Object.freeze({ ...fixture.claim, recordId: "record-other" }),
	}));
await expectRecoveryRejected("wrong operation epoch is rejected", (fixture) =>
	fixture.makeRecoveryRequest({
		recoveryClaim: Object.freeze({
			...fixture.claim,
			recoveryOperationEpoch: fixture.claim.recoveryOperationEpoch + 1,
		}),
	}));
await expectRecoveryRejected("wrong generation is rejected", (fixture) =>
	fixture.makeRecoveryRequest({ handoffGeneration: 4 }));
await expectRecoveryRejected("open input gate is rejected", (fixture) => {
	const ticket = fixture.makeTicket({ inputGateInstalled: false });
	fixture.setTicket(ticket);
	return fixture.makeRecoveryRequest({ openEditorTicket: ticket });
});
await expectRecoveryRejected("installed save guard is rejected", (fixture) => {
	const ticket = fixture.makeTicket({ saveGuardInstalled: true });
	fixture.setTicket(ticket);
	return fixture.makeRecoveryRequest({ openEditorTicket: ticket });
});
await expectRecoveryRejected("wrong reducer marker is rejected", (fixture) => {
	const ticket = fixture.makeTicket({
		recoveryTargetBindingRequest: Object.freeze({
			...fixture.claim,
			recordId: "record-other",
		}),
	});
	fixture.setTicket(ticket);
	return fixture.makeRecoveryRequest({ openEditorTicket: ticket });
});
await expectRecoveryRejected("replacement CM is rejected", (fixture) => {
	const replacementCm = {
		state: EditorState.create({ doc: fixture.base }),
	} as unknown as EditorView;
	const ticket = fixture.makeTicket({ cm: replacementCm });
	fixture.setTicket(ticket);
	return fixture.makeRecoveryRequest({ openEditorTicket: ticket });
});
await expectRecoveryRejected("already-bound pre-bind evidence is rejected", (fixture) => {
	const ticket = fixture.makeTicket({
		binding: Object.freeze({
			kind: "bound",
			path: fixture.path,
			fileId: "file-B",
			ytext: fixture.ytext!,
			bindingEpoch: 11,
		}),
	});
	fixture.setTicket(ticket);
	return fixture.makeRecoveryRequest({ openEditorTicket: ticket });
});

console.log("\n--- Recovery admission: seed is exact certified B base ---");
{
	const fixture = makeFixture({ missingTarget: true });
	const result = await fixture.controller.requestOpenPathAdmission(
		fixture.makeRecoveryRequest(),
	);
	assert(result.kind === "seed-required", "missing recovery target receives one seed plan");
	if (result.kind === "seed-required") {
		const seeded = await fixture.controller.seedMissingTarget(result.plan);
		assert(seeded.kind === "seeded", "certified missing B target is seeded");
		if (seeded.kind === "seeded") {
			assertEq(
				seeded.receipt.replacementTargetReadyToken.certifiedBaseContent,
				fixture.base,
				"replacement token still certifies B base",
			);
		}
	}
	assertEq(fixture.ensureContents.length, 1, "seed path performs exactly one ensureFile");
	assertEq(fixture.ensureContents[0], fixture.base, "seed uses certified B base bytes");
	assert(
		fixture.ensureContents[0] !== "quarantined intent successor",
		"seed never uses quarantined intent successor bytes",
	);
}

console.log("\n--- Recovery admission: exact post-bind freshness survives only the narrow transition ---");
{
	const fixture = makeFixture();
	const result = await fixture.controller.requestOpenPathAdmission(
		fixture.makeRecoveryRequest(),
	);
	assert(result.kind === "existing", "post-bind freshness fixture receives existing token");
	if (result.kind === "existing") {
		const token = result.targetReadyToken;
		const context = fixture.makeFreshnessContext(token);
		assert(
			fixture.controller.isAuthorityFreshnessCurrent(
				token.authorityFreshnessHandleId,
				context,
			),
			"pre-bind exact admission ticket is fresh",
		);
		fixture.setTicket(fixture.makeTicket({
			intentStateKind: "stored",
			binding: Object.freeze({
				kind: "bound",
				path: fixture.path,
				fileId: "file-B",
				ytext: fixture.ytext!,
				bindingEpoch: 11,
			}),
		}));
		fixture.setPostBindSnapshot(fixture.makePostBindSnapshot(token));
		fixture.setRecoveryOwnerProof({ targetReadyToken: token });
		assert(
			fixture.controller.isAuthorityFreshnessCurrent(
				token.authorityFreshnessHandleId,
				context,
			),
			"freshness survives only the exact pre-bind to recovery-bound B transition",
		);
		fixture.setRecoveryOwnerProof({ intentStateKind: "replay-pending" });
		assert(
			fixture.controller.isAuthorityFreshnessCurrent(
				token.authorityFreshnessHandleId,
				context,
			),
			"freshness survives stored to replay-pending without editor drift",
		);

		const exact = fixture.makePostBindSnapshot(token);
		const replacementCm = {
			state: EditorState.create({ doc: fixture.base }),
		} as unknown as EditorView;
		const replacementText = new Y.Doc().getText("replacement-B");
		replacementText.insert(0, fixture.base);
		const replacementFile = makeFile(fixture.path, fixture.base, 99);
		const wrongToken = Object.freeze({
			...token,
			tokenId: `${token.tokenId}-other`,
		});
		const proofRaces: ReadonlyArray<readonly [
			string,
			Partial<RecoveryOwnerProof>,
		]> = [
			["intent", {
				claim: Object.freeze({ ...fixture.claim, intentId: "intent-other" }),
			}],
			["record", {
				claim: Object.freeze({ ...fixture.claim, recordId: "record-other" }),
			}],
			["operation", {
				recoveryOperationEpoch: fixture.claim.recoveryOperationEpoch + 1,
			}],
			["generation", { expectedGeneration: 4 }],
			["token owner", { targetReadyToken: wrongToken }],
			["gate", { inputGateInstalled: false }],
			["save", { saveGuardInstalled: true }],
		];
		for (const [name, race] of proofRaces) {
			fixture.setRecoveryOwnerProof(race);
			assert(
				!fixture.controller.isAuthorityFreshnessCurrent(
					token.authorityFreshnessHandleId,
					context,
				),
				`${name} owner-proof race invalidates recovery freshness`,
			);
			fixture.setRecoveryOwnerProof({
				claim: fixture.claim,
				recoveryOperationEpoch: fixture.claim.recoveryOperationEpoch,
				expectedGeneration: 3,
				targetReadyToken: token,
				inputGateInstalled: true,
				saveGuardInstalled: false,
				intentStateKind: "replay-pending",
			});
		}
		const races: ReadonlyArray<readonly [
			string,
			Partial<RecoverySnapshot>,
		]> = [
			["snapshot operation", {
				recoveryOperationEpoch: fixture.claim.recoveryOperationEpoch + 1,
			}],
			["snapshot generation", { handoffGeneration: 4 }],
			["snapshot token", { targetReadyTokenId: `${token.tokenId}-other` }],
			["host load token", { hostLoadTokenId: "host-load-other" }],
			["host load receipt", { hostLoadReceiptId: "host-receipt-other" }],
			["same-path replacement TFile", { targetFile: replacementFile }],
			["target file id", { targetFileId: "file-other" }],
			["CM", { cm: replacementCm }],
			["binding epoch", { bindingEpoch: 12 }],
			["B to C path", { targetPath: "notes/C.md" }],
			["native history", { nativeHistoryEpoch: exact.nativeHistoryEpoch + 1 }],
			["selection epoch", { selectionEpoch: exact.selectionEpoch + 1 }],
			["selection value", { selection: EditorSelection.cursor(1) }],
			["scroll epoch", { scrollEpoch: exact.scrollEpoch + 1 }],
			// The controller freshness context owns the scroll epoch. The binding
			// owner separately proves the complete live scrollSnapshot (including
			// its actual anchor) stable before replay planning and dispatch.
			["editor document", {
				cmDocument: EditorState.create({ doc: fixture.base }).doc,
			}],
			["editor revision", { editorRevision: exact.editorRevision + 1 }],
			["editor facade content", { editorFacadeContent: "editor-other" }],
			["runtime cache content", { runtimeCacheContent: "cache-other" }],
			["Y.Text object", { ytext: replacementText }],
			["Y.Text identity", { ytextIdentity: "ytext-other" }],
			["Y.Text mutation", { ytextMutationEpoch: exact.ytextMutationEpoch + 1 }],
			["Y.Text content", { ytextContent: "ytext-other" }],
		];
		for (const [name, race] of races) {
			fixture.setPostBindSnapshot(Object.freeze({ ...exact, ...race }));
			assert(
				!fixture.controller.isAuthorityFreshnessCurrent(
					token.authorityFreshnessHandleId,
					context,
				),
				`${name} one-field race invalidates recovery freshness`,
			);
		}
		fixture.setPostBindSnapshot(exact);
		assert(
			!fixture.controller.isAuthorityFreshnessCurrent(
				token.authorityFreshnessHandleId,
				Object.freeze({
					...context,
					targetReadyTokenId: `${token.tokenId}-other`,
				}),
			),
			"wrong caller token context cannot reuse the recovery freshness handle",
		);
	}
}

console.log(`\nEditor authority recovery admission: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
