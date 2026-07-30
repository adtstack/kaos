import type { EditorView } from "@codemirror/view";
import type { TFile } from "obsidian";
import * as Y from "yjs";
import type {
	OpenEditorMutationTicket,
	OpenEditorMutationViewTicket,
} from "../sync/editorBinding";
import type {
	MissingTargetSeedPlan,
	MissingTargetSeedReceipt,
	PendingHostLoadCandidate,
	TargetPresentationPlan,
	TargetPresentationReceipt,
	TargetReadyToken,
} from "../sync/editorHandoffState";
import type { VaultSync } from "../sync/vaultSync";
import type {
	SamePathAdoptionBindContext,
	SamePathAdoptionBindPermit,
	SamePathAdoptionMutationContext,
	SamePathAdoptionMutationPermit,
	SamePathAdoptionSeedContext,
	SamePathAdoptionSeedPermit,
} from "../sync/samePathAdoption";

export type HandoffReplayRecoveryClaim = Readonly<{
	recoveryOperationEpoch: number;
	intentId: string;
	recordId: string;
}>;

/**
 * Binding-owner proof carried only by a recovery-purpose open-path ticket.
 *
 * The ordinary OpenEditorMutationTicket validator must recapture and compare
 * every field in this shape. The controller never infers a recovery claim from
 * the generic handoff phase or equal editor bytes.
 */
export type HandoffReplayRecoveryAdmissionEvidence = Readonly<{
	purpose: "handoff-replay-target-bind";
	recoveryClaim: HandoffReplayRecoveryClaim;
	recoveryTargetBindingRequest: HandoffReplayRecoveryClaim | null;
	inputGateInstalled: boolean;
	saveGuardInstalled: boolean;
	pendingHostLoadCandidate: null;
	intentState: Readonly<{
		kind: "stored" | "replay-pending";
		intentId: string;
		recordId: string;
	}>;
	binding:
		| Readonly<{ kind: "unbound"; bindingEpoch: number }>
		| Readonly<{
			kind: "bound";
			path: string;
			fileId: string;
			ytext: Y.Text;
			bindingEpoch: number;
		}>;
}>;

export type HandoffReplayRecoveryOpenEditorMutationViewTicket =
	OpenEditorMutationViewTicket & Readonly<{
		handoffReplayRecovery: HandoffReplayRecoveryAdmissionEvidence;
	}>;

export type HandoffReplayRecoveryOpenEditorMutationTicket =
	Omit<OpenEditorMutationTicket, "views"> & Readonly<{
		views: readonly HandoffReplayRecoveryOpenEditorMutationViewTicket[];
	}>;

type OpenPathAdmissionRequestBase = Readonly<{
	requestId: string;
	sessionId: string;
	leafId: string;
	handoffGeneration: number;
	switchIntentSeq: number;
	targetPath: string;
	targetFile: TFile;
	presentation: "source" | "target-candidate" | "target-proven";
	hostLoadTokenId: string | null;
}>;

export type OpenPathAdmissionRequest =
	| (OpenPathAdmissionRequestBase & Readonly<{
		reason: "open-editor-missing-target";
		recoveryClaim?: never;
		openEditorTicket: OpenEditorMutationTicket;
	}>)
	| (OpenPathAdmissionRequestBase & Readonly<{
		reason: "handoff-replay-target-bind";
		recoveryClaim: HandoffReplayRecoveryClaim;
		presentation: "target-proven";
		hostLoadTokenId: null;
		openEditorTicket: HandoffReplayRecoveryOpenEditorMutationTicket;
	}>);

export type TargetPresentationRequest = Readonly<{
	requestId: string;
	sessionId: string;
	leafId: string;
	handoffGeneration: number;
	switchIntentSeq: number;
	targetPath: string;
	targetFile: TFile;
	candidate: PendingHostLoadCandidate;
	openEditorTicket: OpenEditorMutationTicket;
}>;

export type AuthorityFreshnessContext = Readonly<{
	sessionId: string;
	leafId: string;
	handoffGeneration: number;
	targetReadyTokenId: string;
	targetFile: TFile;
	hostLoadReceiptId: string;
	cm: EditorView;
	editorRevision: number;
	nativeHistoryEpoch: number;
	selectionEpoch: number;
	scrollEpoch: number;
}>;

export type BindPermitContext = AuthorityFreshnessContext & Readonly<{
	fileId: string;
	ytext: Y.Text;
	ytextIdentity: string;
	ytextMutationEpoch: number;
	bindingEpoch: number;
}>;

/**
 * Exact editor-owned context consumed immediately before the held host load.
 * The candidate and ticket are identity compared; equal bytes cannot forge it.
 */
export type TargetPresentationPermitContext = Readonly<{
	presentationPlanId: string;
	authorityFreshnessHandleId: string;
	sessionId: string;
	leafId: string;
	handoffGeneration: number;
	switchIntentSeq: number;
	targetPath: string;
	targetFile: TFile;
	hostLoadTokenId: string;
	candidate: PendingHostLoadCandidate;
	openEditorTicket: OpenEditorMutationTicket;
}>;

export type OpenPathAdmissionResult =
	| Readonly<{
		kind: "deferred";
		reason:
			| "transitioning"
			| "unstable"
			| "attention"
			| "frontmatter"
			| "tombstone"
			| "multiple-authorities";
	}>
	| Readonly<{ kind: "existing"; targetReadyToken: TargetReadyToken }>
	| Readonly<{ kind: "presentation-required"; plan: TargetPresentationPlan }>
	| Readonly<{ kind: "seed-required"; plan: MissingTargetSeedPlan }>
	| Readonly<{ kind: "replan"; reason: "authority-changed" }>;

export type TargetPresentationResult =
	| Readonly<{ kind: "accepted"; receipt: TargetPresentationReceipt }>
	| Readonly<{
		kind: "replan";
		reason: "presentation-changed" | "authority-changed";
	}>;

export type TargetPresentationRequestResult =
	| Readonly<{ kind: "planned"; plan: TargetPresentationPlan }>
	| Readonly<{
		kind: "deferred";
		reason: "host-candidate-missing" | "authority-blocked";
	}>
	| Readonly<{
		kind: "replan";
		reason: "presentation-changed" | "authority-changed";
	}>;

export type MissingTargetSeedResult =
	| Readonly<{ kind: "seeded"; receipt: MissingTargetSeedReceipt }>
	| Readonly<{
		kind: "replan";
		reason: "authority-changed" | "active-set-changed";
	}>
	| Readonly<{
		kind: "blocked";
		reason: "orphan" | "collision" | "tombstone" | "policy";
	}>;

export type ActivePathAuthoritySnapshot = Readonly<{
	activeFileIds: readonly string[];
	activeSetEpoch: number;
	fileId: string | null;
	ytext: Y.Text | null;
	ytextIdentity: string | null;
	ytextMutationEpoch: number;
	ytextContent: string | null;
}>;

type FreshnessRecord = {
	readonly expectedContext: AuthorityFreshnessContext | null;
	readonly validate: () => boolean;
	active: boolean;
};

type PresentationPermitRecord = {
	readonly expected: TargetPresentationPermitContext;
	consumed: boolean;
};

type BindPermitRecord = {
	readonly freshnessHandleId: string;
	readonly expected: BindPermitContext;
	consumed: boolean;
};

type SeedPermitRecord = {
	readonly planId: string;
	readonly freshnessHandleId: string;
	consumed: boolean;
};

type SamePathAdoptionPermitRecord<Expected, Context = Expected> = {
	readonly expected: Expected;
	readonly validate: (context: Context) => boolean;
	consumed: boolean;
};

type SamePathAdoptionBindExpectation = Pick<
	SamePathAdoptionBindContext,
	"kind" | "proposal" | "request"
>;

type TrackedPath = {
	fingerprint: string;
	epoch: number;
	expiresAt: number;
};

type TrackedVault = {
	readonly vaultSync: VaultSync;
	readonly paths: Map<string, TrackedPath>;
	readonly afterTransaction: (transaction: Y.Transaction) => void;
};

function sameAuthorityContext(
	left: AuthorityFreshnessContext,
	right: AuthorityFreshnessContext,
): boolean {
	return left.sessionId === right.sessionId
		&& left.leafId === right.leafId
		&& left.handoffGeneration === right.handoffGeneration
		&& left.targetReadyTokenId === right.targetReadyTokenId
		&& left.targetFile === right.targetFile
		&& left.hostLoadReceiptId === right.hostLoadReceiptId
		&& left.cm === right.cm
		&& left.editorRevision === right.editorRevision
		&& left.nativeHistoryEpoch === right.nativeHistoryEpoch
		&& left.selectionEpoch === right.selectionEpoch
		&& left.scrollEpoch === right.scrollEpoch;
}

function sameBindContext(left: BindPermitContext, right: BindPermitContext): boolean {
	return sameAuthorityContext(left, right)
		&& left.fileId === right.fileId
		&& left.ytext === right.ytext
		&& left.ytextIdentity === right.ytextIdentity
		&& left.ytextMutationEpoch === right.ytextMutationEpoch
		&& left.bindingEpoch === right.bindingEpoch;
}

function samePresentationContext(
	left: TargetPresentationPermitContext,
	right: TargetPresentationPermitContext,
): boolean {
	return left.presentationPlanId === right.presentationPlanId
		&& left.authorityFreshnessHandleId === right.authorityFreshnessHandleId
		&& left.sessionId === right.sessionId
		&& left.leafId === right.leafId
		&& left.handoffGeneration === right.handoffGeneration
		&& left.switchIntentSeq === right.switchIntentSeq
		&& left.targetPath === right.targetPath
		&& left.targetFile === right.targetFile
		&& left.hostLoadTokenId === right.hostLoadTokenId
		&& left.candidate === right.candidate
		&& left.openEditorTicket === right.openEditorTicket;
}

function sameAdoptionMutationContext(
	left: SamePathAdoptionMutationContext,
	right: SamePathAdoptionMutationContext,
): boolean {
	return left.kind === right.kind
		&& left.proposal === right.proposal
		&& left.request === right.request;
}

function sameAdoptionBindContext(
	left: SamePathAdoptionBindExpectation,
	right: SamePathAdoptionBindContext,
): boolean {
	return left.kind === right.kind
		&& left.proposal === right.proposal
		&& left.request === right.request;
}

function sameAdoptionSeedContext(
	left: SamePathAdoptionSeedContext,
	right: SamePathAdoptionSeedContext,
): boolean {
	return left.kind === right.kind
		&& left.request === right.request
		&& left.file === right.file
		&& left.diskContent === right.diskContent;
}

/**
 * Private-registry owner for nominal handles, action-specific permits, object
 * identities, and mutation epochs. Public callers only ever receive strings;
 * possession of a structurally equal object cannot mint or refresh authority.
 */
export class EditorAuthorityAdmissionRegistry {
	private static readonly ACTIVE_PATH_TRACKING_TTL_MS = 30_000;
	private static readonly MAX_NOMINAL_RECORDS = 2048;
	private readonly nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	private sequence = 0;
	private activePathEpochSequence = 0;
	private readonly freshness = new Map<string, FreshnessRecord>();
	private readonly presentationPermits = new Map<string, PresentationPermitRecord>();
	private readonly bindPermits = new Map<string, BindPermitRecord>();
	private readonly seedPermits = new Map<string, SeedPermitRecord>();
	private readonly samePathAdoptionMutationPermits =
		new Map<SamePathAdoptionMutationPermit, SamePathAdoptionPermitRecord<
			SamePathAdoptionMutationContext
		>>();
	private readonly samePathAdoptionBindPermits =
		new Map<SamePathAdoptionBindPermit, SamePathAdoptionPermitRecord<
			SamePathAdoptionBindExpectation,
			SamePathAdoptionBindContext
		>>();
	private readonly samePathAdoptionSeedPermits =
		new Map<SamePathAdoptionSeedPermit, SamePathAdoptionPermitRecord<
			SamePathAdoptionSeedContext
		>>();
	private readonly ticketIds = new WeakMap<OpenEditorMutationTicket, string>();
	private readonly ytextIds = new WeakMap<Y.Text, string>();
	private readonly ytextMutationEpochs = new WeakMap<Y.Text, number>();
	private readonly trackedVaults = new Map<VaultSync, TrackedVault>();

	nextId(kind: string): string {
		return `${kind}-${this.nonce}-${++this.sequence}`;
	}

	getTicketId(ticket: OpenEditorMutationTicket): string {
		let id = this.ticketIds.get(ticket);
		if (!id) {
			id = this.nextId("editor-ticket");
			this.ticketIds.set(ticket, id);
		}
		return id;
	}

	getYTextIdentity(ytext: Y.Text): string {
		let id = this.ytextIds.get(ytext);
		if (!id) {
			id = this.nextId("ytext");
			this.ytextIds.set(ytext, id);
		}
		return id;
	}

	getYTextMutationEpoch(ytext: Y.Text): number {
		return this.ytextMutationEpochs.get(ytext) ?? 0;
	}

	captureActivePathAuthority(
		vaultSync: VaultSync,
		path: string,
	): ActivePathAuthoritySnapshot {
		const tracked = this.ensureTrackedVault(vaultSync);
		const fingerprint = this.activePathFingerprint(vaultSync, path);
		let state = tracked.paths.get(path);
		const now = Date.now();
		if (!state || state.expiresAt <= now) {
			state = {
				fingerprint,
				epoch: ++this.activePathEpochSequence,
				expiresAt: now + EditorAuthorityAdmissionRegistry.ACTIVE_PATH_TRACKING_TTL_MS,
			};
			tracked.paths.set(path, state);
		} else if (state.fingerprint !== fingerprint) {
			state.fingerprint = fingerprint;
			state.epoch = ++this.activePathEpochSequence;
		}
		state.expiresAt = now + EditorAuthorityAdmissionRegistry.ACTIVE_PATH_TRACKING_TTL_MS;
		const activeFileIds = [...vaultSync.getActiveFileIdsForPath(path)].sort();
		const ytext = vaultSync.getTextForPath(path);
		const fileId = ytext
			? (vaultSync.getFileIdForText(ytext) ?? vaultSync.getFileId(path) ?? null)
			: (vaultSync.getFileId(path) ?? null);
		return Object.freeze({
			activeFileIds: Object.freeze(activeFileIds),
			activeSetEpoch: state.epoch,
			fileId,
			ytext,
			ytextIdentity: ytext ? this.getYTextIdentity(ytext) : null,
			ytextMutationEpoch: ytext ? this.getYTextMutationEpoch(ytext) : 0,
			ytextContent: ytext?.toJSON() ?? null,
		});
	}

	issueFreshness(
		expectedContext: AuthorityFreshnessContext | null,
		validate: () => boolean,
	): string {
		const handleId = this.nextId("authority-freshness");
		this.trimNominalMap(this.freshness);
		this.freshness.set(handleId, {
			expectedContext: expectedContext ? Object.freeze({ ...expectedContext }) : null,
			validate,
			active: true,
		});
		return handleId;
	}

	setFreshnessContext(handleId: string, context: AuthorityFreshnessContext): boolean {
		const record = this.freshness.get(handleId);
		if (!record || !record.active || record.expectedContext !== null) return false;
		this.freshness.set(handleId, {
			...record,
			expectedContext: Object.freeze({ ...context }),
		});
		return true;
	}

	isFreshnessCurrent(handleId: string, context: AuthorityFreshnessContext): boolean {
		const record = this.freshness.get(handleId);
		return !!record
			&& record.active
			&& record.expectedContext !== null
			&& sameAuthorityContext(record.expectedContext, context)
			&& record.validate();
	}

	isOpaqueFreshnessCurrent(handleId: string): boolean {
		const record = this.freshness.get(handleId);
		return !!record && record.active && record.validate();
	}

	invalidateFreshness(handleId: string): void {
		const record = this.freshness.get(handleId);
		if (record) record.active = false;
	}

	issuePresentationPermit(
		permitId: string,
		expected: TargetPresentationPermitContext,
	): void {
		this.trimNominalMap(this.presentationPermits);
		this.presentationPermits.set(permitId, {
			expected: Object.freeze({ ...expected }),
			consumed: false,
		});
	}

	consumePresentationPermit(
		permitId: string,
		context: TargetPresentationPermitContext,
	): boolean {
		const record = this.presentationPermits.get(permitId);
		if (
			!record
			|| record.consumed
			|| !samePresentationContext(record.expected, context)
			|| !this.isOpaqueFreshnessCurrent(context.authorityFreshnessHandleId)
		) return false;
		record.consumed = true;
		this.invalidateFreshness(context.authorityFreshnessHandleId);
		return true;
	}

	isPresentationPermitConsumed(permitId: string): boolean {
		return this.presentationPermits.get(permitId)?.consumed === true;
	}

	issueBindPermit(
		permitId: string,
		freshnessHandleId: string,
		expected: BindPermitContext,
	): void {
		this.trimNominalMap(this.bindPermits);
		this.bindPermits.set(permitId, {
			freshnessHandleId,
			expected: Object.freeze({ ...expected }),
			consumed: false,
		});
	}

	consumeBindPermit(permitId: string, context: BindPermitContext): boolean {
		const record = this.bindPermits.get(permitId);
		if (
			!record
			|| record.consumed
			|| !sameBindContext(record.expected, context)
			|| !this.isFreshnessCurrent(record.freshnessHandleId, context)
		) return false;
		record.consumed = true;
		return true;
	}

	issueSeedPermit(permitId: string, planId: string, freshnessHandleId: string): void {
		this.trimNominalMap(this.seedPermits);
		this.seedPermits.set(permitId, {
			planId,
			freshnessHandleId,
			consumed: false,
		});
	}

	consumeSeedPermit(permitId: string, planId: string): boolean {
		const record = this.seedPermits.get(permitId);
		if (
			!record
			|| record.consumed
			|| record.planId !== planId
			|| !this.isOpaqueFreshnessCurrent(record.freshnessHandleId)
		) return false;
		record.consumed = true;
		return true;
	}

	issueSamePathAdoptionMutationPermit(
		expected: SamePathAdoptionMutationContext,
		validate: (context: SamePathAdoptionMutationContext) => boolean,
	): SamePathAdoptionMutationPermit {
		const permit = Object.freeze({
			permitId: this.nextId("same-path-adoption-mutation-permit"),
			kind: "same-path-adoption-mutation" as const,
		}) as SamePathAdoptionMutationPermit;
		this.trimNominalMap(this.samePathAdoptionMutationPermits);
		this.samePathAdoptionMutationPermits.set(permit, {
			expected: Object.freeze({ ...expected }),
			validate,
			consumed: false,
		});
		return permit;
	}

	consumeSamePathAdoptionMutationPermit(
		permit: SamePathAdoptionMutationPermit,
		context: SamePathAdoptionMutationContext,
	): boolean {
		const record = this.samePathAdoptionMutationPermits.get(permit);
		if (
			!record
			|| record.consumed
			|| !sameAdoptionMutationContext(record.expected, context)
			|| !record.validate(context)
		) return false;
		record.consumed = true;
		return true;
	}

	issueSamePathAdoptionBindPermit(
		expected: SamePathAdoptionBindExpectation,
		validate: (context: SamePathAdoptionBindContext) => boolean,
	): SamePathAdoptionBindPermit {
		const permit = Object.freeze({
			permitId: this.nextId("same-path-adoption-bind-permit"),
			kind: "same-path-adoption-bind" as const,
		}) as SamePathAdoptionBindPermit;
		this.trimNominalMap(this.samePathAdoptionBindPermits);
		this.samePathAdoptionBindPermits.set(permit, {
			expected: Object.freeze({ ...expected }),
			validate,
			consumed: false,
		});
		return permit;
	}

	consumeSamePathAdoptionBindPermit(
		permit: SamePathAdoptionBindPermit,
		context: SamePathAdoptionBindContext,
	): boolean {
		const record = this.samePathAdoptionBindPermits.get(permit);
		if (
			!record
			|| record.consumed
			|| !sameAdoptionBindContext(record.expected, context)
			|| !record.validate(context)
		) return false;
		record.consumed = true;
		return true;
	}

	issueSamePathAdoptionSeedPermit(
		expected: SamePathAdoptionSeedContext,
		validate: (context: SamePathAdoptionSeedContext) => boolean,
	): SamePathAdoptionSeedPermit {
		const permit = Object.freeze({
			permitId: this.nextId("same-path-adoption-seed-permit"),
			kind: "same-path-adoption-seed" as const,
		}) as SamePathAdoptionSeedPermit;
		this.trimNominalMap(this.samePathAdoptionSeedPermits);
		this.samePathAdoptionSeedPermits.set(permit, {
			expected: Object.freeze({ ...expected }),
			validate,
			consumed: false,
		});
		return permit;
	}

	consumeSamePathAdoptionSeedPermit(
		permit: SamePathAdoptionSeedPermit,
		context: SamePathAdoptionSeedContext,
	): boolean {
		const record = this.samePathAdoptionSeedPermits.get(permit);
		if (
			!record
			|| record.consumed
			|| !sameAdoptionSeedContext(record.expected, context)
			|| !record.validate(context)
		) return false;
		record.consumed = true;
		return true;
	}

	reset(): void {
		for (const tracked of this.trackedVaults.values()) {
			tracked.vaultSync.ydoc.off("afterTransaction", tracked.afterTransaction);
		}
		this.trackedVaults.clear();
		this.freshness.clear();
		this.presentationPermits.clear();
		this.bindPermits.clear();
		this.seedPermits.clear();
		this.samePathAdoptionMutationPermits.clear();
		this.samePathAdoptionBindPermits.clear();
		this.samePathAdoptionSeedPermits.clear();
	}

	private ensureTrackedVault(vaultSync: VaultSync): TrackedVault {
		const existing = this.trackedVaults.get(vaultSync);
		if (existing) return existing;
		const paths = new Map<string, TrackedPath>();
		const afterTransaction = (transaction: Y.Transaction): void => {
			for (const changedType of transaction.changed.keys()) {
				if (!(changedType instanceof Y.Text)) continue;
				this.ytextMutationEpochs.set(
					changedType,
					(this.ytextMutationEpochs.get(changedType) ?? 0) + 1,
				);
			}
			const now = Date.now();
			for (const [path, state] of paths) {
				if (state.expiresAt <= now) {
					paths.delete(path);
					continue;
				}
				const fingerprint = this.activePathFingerprint(vaultSync, path);
				if (fingerprint === state.fingerprint) continue;
				state.fingerprint = fingerprint;
				state.epoch = ++this.activePathEpochSequence;
			}
		};
		const tracked: TrackedVault = { vaultSync, paths, afterTransaction };
		vaultSync.ydoc.on("afterTransaction", afterTransaction);
		this.trackedVaults.set(vaultSync, tracked);
		return tracked;
	}

	private activePathFingerprint(vaultSync: VaultSync, path: string): string {
		const activeIds = [...vaultSync.getActiveFileIdsForPath(path)].sort();
		const ytext = vaultSync.getTextForPath(path);
		const ytextIdentity = ytext ? this.getYTextIdentity(ytext) : null;
		return JSON.stringify([
			activeIds,
			vaultSync.getFileId(path) ?? null,
			ytextIdentity,
		]);
	}

	private trimNominalMap<K, T>(map: Map<K, T>): void {
		while (map.size >= EditorAuthorityAdmissionRegistry.MAX_NOMINAL_RECORDS) {
			const oldest = map.keys().next().value as K | undefined;
			if (oldest === undefined) return;
			map.delete(oldest);
		}
	}
}
