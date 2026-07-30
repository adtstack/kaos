import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MarkdownView, TFile } from "obsidian";
import type * as Y from "yjs";
import type {
	SamePathAdoptionPlan,
} from "../runtime/reconcile/samePathAdoptionPlanner";
import type {
	ActivePathAuthoritySnapshot,
} from "../runtime/editorAuthorityAdmission";
import type {
	OpenEditorMutationTicket,
} from "./editorBinding";
import type {
	EditorAuthorityLease,
	PathEditorAuthority,
} from "./pathEditorAuthority";
import type {
	TextFileViewHostCapability,
} from "./textFileViewHandoffGuard";

declare const samePathAdoptionMutationPermitBrand: unique symbol;
declare const samePathAdoptionBindPermitBrand: unique symbol;
declare const samePathAdoptionSeedPermitBrand: unique symbol;

export type SamePathAdoptionMutationPermit = Readonly<{
	permitId: string;
	kind: "same-path-adoption-mutation";
	readonly [samePathAdoptionMutationPermitBrand]: true;
}>;

export type SamePathAdoptionBindPermit = Readonly<{
	permitId: string;
	kind: "same-path-adoption-bind";
	readonly [samePathAdoptionBindPermitBrand]: true;
}>;

export type SamePathAdoptionSeedPermit = Readonly<{
	permitId: string;
	kind: "same-path-adoption-seed";
	readonly [samePathAdoptionSeedPermitBrand]: true;
}>;

export type SamePathAdoptionRequest = Readonly<{
	requestId: string;
	adoptionId: string;
	sessionId: string;
	leafId: string;
	generation: number;
	path: string;
	file: TFile;
	fileId: string | null;
	ytext: Y.Text | null;
	openEditorTicket: OpenEditorMutationTicket;
	editorAuthority: PathEditorAuthority;
	hostCapability: TextFileViewHostCapability;
	hostSaveEpoch: number;
	cm: EditorView;
	startDocument: Text;
	editorRevision: number;
	editorTransactionSeq: number;
	bindingEpoch: number;
	nativeHistoryEpoch: number;
	inputEpoch: number;
	compositionEpoch: number;
	activeCompositionEpoch: number | null;
	selectionEpoch: number;
	scrollEpoch: number;
}>;

export type SamePathAdoptionProposal = Readonly<{
	proposalId: string;
	planId: string;
	authorityFreshnessHandleId: string;
	request: SamePathAdoptionRequest;
	adoptionId: string;
	path: string;
	file: TFile;
	baselineHash: string | null;
	baselineRevision: number;
	baselineText: string | null;
	diskFile: TFile;
	diskStat: Readonly<{
		ctime: number | null;
		mtime: number | null;
		size: number | null;
	}>;
	diskContent: string;
	diskContentHash: string;
	localText: string;
	remoteText: string;
	activeAuthority: ActivePathAuthoritySnapshot;
	fileId: string;
	ytext: Y.Text;
	ytextIdentity: string;
	ytextMutationEpoch: number;
	providerInstance: object | null;
	editorAuthorityLease: EditorAuthorityLease;
	hostCapability: TextFileViewHostCapability;
	hostSaveEpoch: number;
	lifecycleGeneration: number;
	attentionGeneration: number;
	syncScopeGeneration: number;
	plan: SamePathAdoptionPlan;
	mutationPermit: SamePathAdoptionMutationPermit;
	bindPermit: SamePathAdoptionBindPermit;
}>;

export type SamePathAdoptionMutationContext = Readonly<{
	kind: "mutation";
	proposal: SamePathAdoptionProposal;
	request: SamePathAdoptionRequest;
}>;

/**
 * Fresh authority captured only after both mutable documents reached the
 * proposal target.  The pre-mutation request is intentionally not reusable as
 * bind authority: a successful projection necessarily changes its document
 * and/or Y.Text epochs.
 */
export type SamePathAdoptionPostMutationProof = Readonly<{
	targetText: string;
	openEditorTicket: OpenEditorMutationTicket;
	editorAuthority: PathEditorAuthority;
	hostCapability: TextFileViewHostCapability;
	hostSaveEpoch: number;
	cm: EditorView;
	editorDocument: Text;
	editorRevision: number;
	editorTransactionSeq: number;
	bindingEpoch: number;
	nativeHistoryEpoch: number;
	inputEpoch: number;
	compositionEpoch: number;
	activeCompositionEpoch: number | null;
	selectionEpoch: number;
	scrollEpoch: number;
	ytextIdentity: string;
	ytextMutationEpoch: number;
}>;

export type SamePathAdoptionBindContext = Readonly<{
	kind: "bind";
	proposal: SamePathAdoptionProposal;
	request: SamePathAdoptionRequest;
	postMutation: SamePathAdoptionPostMutationProof;
}>;

export type SamePathAdoptionSeedContext = Readonly<{
	kind: "seed";
	request: SamePathAdoptionRequest;
	file: TFile;
	diskContent: string;
}>;

export type SamePathAdoptionConflictFailureReason =
	| "artifact-preservation-failed";

export type SamePathAdoptionConflictReceipt = Readonly<{
	receiptId: string;
	adoptionId: string;
	path: string;
	status: "preserved" | "preservation-failed";
	retryable: boolean;
	mergeMode: "three-way" | "two-way";
	baseHash: string | null;
	crdtArtifactPath: string | null;
	editorArtifactPath: string | null;
	editorArtifactPaths: readonly string[];
	editorArtifacts: readonly Readonly<{
		path: string;
		contentHash: string;
		leafIds: readonly string[];
	}>[];
	failureReason: SamePathAdoptionConflictFailureReason | null;
}>;

export type SamePathAdoptionBindReceipt = Readonly<{
	receiptId: string;
	proposalId: string;
	adoptionId: string;
	path: string;
	file: TFile;
	fileId: string;
	ytext: Y.Text;
	ytextIdentity: string;
	ytextMutationEpoch: number;
	targetText: string;
}>;

export type SamePathAdoptionRequestResult =
	| Readonly<{ kind: "planned"; proposal: SamePathAdoptionProposal }>
	| Readonly<{ kind: "seeded-replan" }>
	| Readonly<{
		kind: "conflict-preserved";
		receipt: SamePathAdoptionConflictReceipt;
	}>
	| Readonly<{
		kind: "conflict-preservation-failed";
		reason: SamePathAdoptionConflictFailureReason;
		receipt: SamePathAdoptionConflictReceipt;
	}>
	| Readonly<{ kind: "replan"; reason: string }>;

export interface SamePathAdoptionControllerPort {
	requestSamePathAdoption(
		request: SamePathAdoptionRequest,
	): Promise<SamePathAdoptionRequestResult>;
	consumeSamePathAdoptionMutationPermit(
		permit: SamePathAdoptionMutationPermit,
		context: SamePathAdoptionMutationContext,
	): boolean;
	consumeSamePathAdoptionBindPermit(
		permit: SamePathAdoptionBindPermit,
		context: SamePathAdoptionBindContext,
	): boolean;
	noteSamePathAdoptionBound(receipt: SamePathAdoptionBindReceipt): void;
}

export type SamePathAdoptionState =
	| Readonly<{ kind: "none" }>
	| Readonly<{
		kind: "capturing" | "planning";
		adoptionId: string;
		requestId: string | null;
		sessionId: string;
		generation: number;
		view: MarkdownView;
		file: TFile;
		path: string;
		cm: EditorView;
		startDocument: Text;
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
		hostCapability: TextFileViewHostCapability;
		hostSaveEpoch: number;
		proposal: SamePathAdoptionProposal | null;
	}>
	| Readonly<{
		kind: "awaiting-disk";
		adoptionId: string;
		proposalId: string;
		path: string;
		file: TFile;
		fileId: string;
		ytext: Y.Text;
		targetText: string;
		bindReceipt: SamePathAdoptionBindReceipt;
	}>
	| Readonly<{
		kind: "conflict";
		adoptionId: string;
		path: string;
		status: "preserved" | "preservation-failed";
		retryable: boolean;
		mergeMode: "three-way" | "two-way";
		baseHash: string | null;
		crdtArtifactPath: string | null;
		editorArtifactPath: string | null;
		editorArtifactPaths: readonly string[];
		failureReason: SamePathAdoptionConflictFailureReason | null;
		remoteText: string;
	}>;

export const NO_SAME_PATH_ADOPTION: SamePathAdoptionState = Object.freeze({
	kind: "none",
});
