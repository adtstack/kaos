import type { EditorBindingManager } from "../sync/editorBinding";
import type {
	HandoffInputIntent,
	TargetReadyToken,
} from "../sync/editorHandoffState";
import {
	verifyFreshStoredHandoffClaim,
	type HandoffCompositionProof,
	type HandoffReplayDispatchReceipt,
} from "../sync/editorHandoffReplay";
import {
	canonicalHandoffRecoveryJson,
	hashHandoffRecoveryDispatchReceipt,
	isActiveHandoffRecoveryRecord,
	validateHandoffRecoveryRecord,
	type ActiveHandoffRecoveryRecord,
	type HandoffRecoveryApplyWitness,
	type HandoffRecoveryCasResult,
	type HandoffRecoveryRecord,
	type HandoffRecoveryStore,
	type TerminalHandoffRecoveryReceipt,
} from "../sync/handoffRecoveryStore";
import type { ReconciliationController } from "./reconciliationController";
import type {
	HandoffAwaitingSettlementObserver,
	HandoffIntentState,
	HandoffRecoveryRuntimeRequest,
	HandoffStoredIntentClassifier,
} from "./handoffRecoveryCoordinator";
import { observeHandoffReplayClassificationForQa } from "./handoffReplayQaObserver";

declare const __KAOS_QA_HARNESS_ENABLED__: boolean;
const HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED =
	typeof __KAOS_QA_HARNESS_ENABLED__ !== "undefined"
	&& __KAOS_QA_HARNESS_ENABLED__;

type StoredRecord = ActiveHandoffRecoveryRecord & Readonly<{ status: "stored" }>;
type ReplayPendingRecord = ActiveHandoffRecoveryRecord & Readonly<{
	status: "replay-pending";
}>;
type AwaitingRecord = ActiveHandoffRecoveryRecord & Readonly<{
	status: "replayed-awaiting-settlement";
}>;
type NeedsReviewRecord = ActiveHandoffRecoveryRecord & Readonly<{
	status: "needs-review";
}>;

function createHandoffReplayClassificationQaInput(
	request: HandoffRecoveryRuntimeRequest,
	record: StoredRecord,
	outcome: "claimed" | "manual",
	reason: Parameters<typeof observeHandoffReplayClassificationForQa>[1]["reason"],
): Parameters<typeof observeHandoffReplayClassificationForQa>[1] {
	return Object.freeze({
		outcome,
		reason,
		recordId: record.recordId,
		intentId: request.intent.intentId,
		sessionId: request.sessionId,
		expectedGeneration: request.expectedGeneration,
	});
}

type ReplayStoreConvergence =
	| { kind: "stored"; record: StoredRecord }
	| { kind: "replay-pending"; record: ReplayPendingRecord }
	| { kind: "awaiting"; record: AwaitingRecord }
	| { kind: "needs-review"; record: NeedsReviewRecord }
	| { kind: "terminal"; record: TerminalHandoffRecoveryReceipt }
	| { kind: "failed"; reason: "missing" | "corrupt" | "scope-stale" };

type HandoffReplayControllerPort = Pick<
	ReconciliationController,
	| "requestExactHandoffReplayPlan"
	| "consumeExactHandoffReplayPermit"
	| "createExactHandoffReplayDispatchReceipt"
	| "observeExactHandoffReplaySettlement"
	| "invalidateExactHandoffReplayForRecoveryClear"
	| "invalidateExactHandoffReplayForRecord"
>;

type HandoffReplayEditorBindingsPort = Pick<
	EditorBindingManager,
	| "captureHandoffCompositionProof"
	| "captureCurrentTargetReadyToken"
	| "applyExactHandoffReplay"
>;

export interface HandoffReplayCoordinatorDeps {
	store: HandoffRecoveryStore;
	controller: HandoffReplayControllerPort;
	editorBindings: HandoffReplayEditorBindingsPort;
	now?: () => number;
	validateRecord?: typeof validateHandoffRecoveryRecord;
	isScopeCurrent(): boolean;
}

type LiveHandoffReplayClaim = {
	readonly request: HandoffRecoveryRuntimeRequest;
	readonly intent: HandoffInputIntent;
	readonly intentEnvelopeHash: string;
	readonly compositionProof: HandoffCompositionProof | null;
	record: StoredRecord | ReplayPendingRecord | AwaitingRecord;
	latestTargetReadyToken: TargetReadyToken | null;
	lastAttemptedTargetReadyToken: TargetReadyToken | null;
	receipt: HandoffReplayDispatchReceipt | null;
	receiptHash: string | null;
	dispatchOccurred: boolean;
	bindingRequestAccepted: boolean;
	retired: boolean;
	actionEpoch: number;
};

type RetiredClearClaim = Readonly<{
	recordId: string;
	intentEnvelopeHash: string;
	receiptHash: string | null;
}>;

/**
 * Owns only the ephemeral, single-process claim that joins the durable Recovery
 * row to the controller's one-shot plan/permit authority. Durable state remains
 * exclusively owned by HandoffRecoveryStore and reducer delivery remains owned
 * by the original HandoffRecoveryRuntimeRequest.
 */
export class HandoffReplayCoordinator {
	readonly classifyStoredIntent: HandoffStoredIntentClassifier;
	readonly observeHydratedAwaitingSettlement: HandoffAwaitingSettlementObserver;

	private readonly store: HandoffRecoveryStore;
	private readonly controller: HandoffReplayControllerPort;
	private readonly editorBindings: HandoffReplayEditorBindingsPort;
	private readonly now: () => number;
	private readonly validateRecord: typeof validateHandoffRecoveryRecord;
	private readonly isScopeCurrent: () => boolean;
	private readonly claims = new Map<string, LiveHandoffReplayClaim>();
	private readonly tails = new Map<string, Promise<void>>();
	private retiredForClear: RetiredClearClaim[] = [];
	private actionEpoch = 0;

	constructor(deps: HandoffReplayCoordinatorDeps) {
		this.store = deps.store;
		this.controller = deps.controller;
		this.editorBindings = deps.editorBindings;
		this.now = deps.now ?? (() => Date.now());
		this.validateRecord = deps.validateRecord ?? validateHandoffRecoveryRecord;
		this.isScopeCurrent = () => deps.isScopeCurrent();
		this.classifyStoredIntent = this.classifyFreshStoredIntent.bind(this);
		this.observeHydratedAwaitingSettlement =
			this.observeHydratedSettlement.bind(this);
	}

	notifyTargetReady(token: TargetReadyToken): void {
		for (const claim of this.claims.values()) {
			if (
				!this.isClaimCurrent(claim)
				|| claim.record.status !== "stored"
				|| !claim.bindingRequestAccepted
				|| token.sessionId !== claim.request.sessionId
				|| token.handoffGeneration !== claim.request.expectedGeneration
				|| token.switchIntentSeq !== claim.intent.switchIntentSeq
				|| token.targetPath !== claim.intent.targetPath
				|| token.targetFile !== claim.intent.targetFile
				|| token === claim.latestTargetReadyToken
			) continue;
			claim.latestTargetReadyToken = token;
			this.enqueue(claim, () => this.resumeClaim(claim));
		}
	}

	notifyTargetPresentationReady(token: TargetReadyToken): void {
		for (const claim of this.claims.values()) {
			if (
				!this.isClaimCurrent(claim)
				|| claim.record.status !== "stored"
				|| claim.bindingRequestAccepted
				|| !this.tokenMatchesClaim(token, claim)
			) continue;
			this.enqueue(claim, async () => {
				const requested = this.requestTargetBinding(claim, token);
				if (requested === "rejected") {
					await this.demoteRecord(claim.request, claim.record, claim, true);
				}
			});
		}
	}

	notifySettlementMayHaveAdvanced(targetPath: string): void {
		for (const claim of this.claims.values()) {
			if (
				this.isClaimCurrent(claim)
				&& claim.record.status === "replayed-awaiting-settlement"
				&& claim.intent.targetPath === targetPath
			) this.enqueue(claim, () => this.observeLiveSettlement(claim));
		}
	}

	async continueWithoutAutomaticApply(
		request: HandoffRecoveryRuntimeRequest,
		recordId: string,
		isManualActionCurrent: () => boolean,
	): Promise<void> {
		const claim = this.claims.get(recordId) ?? null;
		if (claim) this.retireClaim(claim);
		// This must happen before hydrateScope's first await. It makes a reentrant
		// gate action unable to consume a plan or permit after the manual choice.
		this.controller.invalidateExactHandoffReplayForRecord(recordId);
		const actionEpoch = this.actionEpoch;
		const isActionCurrent = () =>
			actionEpoch === this.actionEpoch
			&& this.isScopeCurrent()
			&& isManualActionCurrent();
		await this.enqueueRecordAction(recordId, isActionCurrent, async () => {
			const intentEnvelopeHash = claim?.intentEnvelopeHash
				?? await this.findIntentEnvelopeHash(recordId, request.intent.intentId);
			if (intentEnvelopeHash === null || !isActionCurrent()) return;
			const current = await this.convergeReplayStoreMutation(
				recordId,
				intentEnvelopeHash,
				claim?.receiptHash ?? null,
			);
			if (!isActionCurrent()) return;
			await this.demoteConvergedRecord(
				request,
				current,
				true,
				isActionCurrent,
			);
		});
	}

	retrySettlement(recordId: string): void {
		const claim = this.claims.get(recordId);
		if (
			claim
			&& this.isClaimCurrent(claim)
			&& claim.record.status === "replayed-awaiting-settlement"
		) this.enqueue(claim, () => this.observeLiveSettlement(claim));
	}

	/** Synchronously retire live authority before Clear performs its first await. */
	invalidateForRecoveryClear(): void {
		this.actionEpoch += 1;
		const retired = new Map(
			this.retiredForClear.map((claim) => [claim.recordId, claim] as const),
		);
		for (const claim of this.claims.values()) {
			retired.set(claim.record.recordId, {
				recordId: claim.record.recordId,
				intentEnvelopeHash: claim.intentEnvelopeHash,
				receiptHash: claim.receiptHash,
			});
		}
		this.retiredForClear = Array.from(retired.values());
		for (const claim of this.claims.values()) claim.retired = true;
		this.claims.clear();
		this.controller.invalidateExactHandoffReplayForRecoveryClear();
	}

	async drainAndDemoteForRecoveryClear(): Promise<void> {
		await this.drainTails();
		while (this.retiredForClear.length > 0) {
			const retired = this.retiredForClear;
			this.retiredForClear = [];
			for (const entry of retired) {
				const current = await this.convergeReplayStoreMutation(
					entry.recordId,
					entry.intentEnvelopeHash,
					entry.receiptHash,
				);
				if (current.kind === "replay-pending") {
					await this.demoteReplayPendingForClear(entry, current.record, true);
				}
			}
		}
		await this.store.drain();
	}

	async drain(): Promise<void> {
		await this.drainTails();
		await this.store.drain();
	}

	private async classifyFreshStoredIntent(
		request: HandoffRecoveryRuntimeRequest,
		record: StoredRecord,
	): Promise<"claimed" | "manual"> {
		if (!this.isScopeCurrent()) {
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", "scope-stale-at-entry",
				));
			}
			return "manual";
		}
		if (request.sessionId !== request.intent.sessionId) {
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", "request-session-mismatch",
				));
			}
			return "manual";
		}
		if (request.expectedGeneration !== request.intent.handoffGeneration) {
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", "request-generation-mismatch",
				));
			}
			return "manual";
		}
		if (record.intentId !== request.intent.intentId) {
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", "record-intent-mismatch",
				));
			}
			return "manual";
		}
		if (record.body.eventProof.sessionId !== request.sessionId) {
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", "event-proof-session-mismatch",
				));
			}
			return "manual";
		}
		if (record.body.eventProof.handoffGeneration !== request.expectedGeneration) {
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", "event-proof-generation-mismatch",
				));
			}
			return "manual";
		}

		let validated: HandoffRecoveryRecord;
		try {
			validated = await this.validateRecord(record);
		} catch {
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", "record-validation-failed",
				));
			}
			return "manual";
		}
		if (validated !== record) {
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", "record-validation-replaced",
				));
			}
			return "manual";
		}
		if (validated.status !== "stored") {
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", "record-validation-status-changed",
				));
			}
			return "manual";
		}

		const captured = this.editorBindings.captureHandoffCompositionProof(request.intent);
		const compositionProof = request.intent.compositionEpoch === null
			? captured.kind === "not-ime" ? null : undefined
			: captured.kind === "ready" ? captured.proof : undefined;
		if (compositionProof === undefined) {
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", "composition-proof-unavailable",
				));
			}
			return "manual";
		}
		const verified = await verifyFreshStoredHandoffClaim(
			request.intent,
			record,
			compositionProof,
		);
		if (verified.kind === "manual") {
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", `verify-manual:${verified.reason}`,
				));
			}
			return "manual";
		}
		if (verified.kind === "replan") {
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", `verify-replan:${verified.reason}`,
				));
			}
			return "manual";
		}
		if (!this.isScopeCurrent()) {
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", "scope-stale-after-verification",
				));
			}
			return "manual";
		}

		const claim: LiveHandoffReplayClaim = {
			request,
			intent: request.intent,
			intentEnvelopeHash: record.intentEnvelopeHash,
			compositionProof,
			record,
			latestTargetReadyToken: null,
			lastAttemptedTargetReadyToken: null,
			receipt: null,
			receiptHash: null,
			dispatchOccurred: false,
			bindingRequestAccepted: false,
			retired: false,
			actionEpoch: this.actionEpoch,
		};
		const existing = this.claims.get(record.recordId);
		if (existing) this.retireClaim(existing);
		this.claims.set(record.recordId, claim);
		const presentationToken = this.editorBindings.captureCurrentTargetReadyToken({
			sessionId: request.sessionId,
			expectedGeneration: request.expectedGeneration,
			targetPath: request.intent.targetPath,
			targetFile: request.intent.targetFile,
		});
		const bindingRequest = presentationToken
			? this.requestTargetBinding(claim, presentationToken)
			: "pending";
		if (bindingRequest === "rejected") {
			this.retireClaim(claim);
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request, record, "manual", "binding-request-rejected",
				));
			}
			return "manual";
		}
		if (bindingRequest === "stale" || !this.isClaimCurrent(claim)) {
			this.retireClaim(claim);
			if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
				observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
					request,
					record,
					"manual",
					bindingRequest === "stale"
						? "binding-request-context-stale"
						: "claim-stale-after-binding-request",
				));
			}
			return "manual";
		}
		if (HANDOFF_REPLAY_CLASSIFICATION_QA_ENABLED) {
			observeHandoffReplayClassificationForQa(this, createHandoffReplayClassificationQaInput(
				request,
				record,
				"claimed",
				bindingRequest === "accepted"
					? "claimed-binding-requested"
					: "claimed-awaiting-presentation",
			));
		}
		return "claimed";
	}

	private requestTargetBinding(
		claim: LiveHandoffReplayClaim,
		token: TargetReadyToken,
	): "accepted" | "rejected" | "stale" {
		if (
			!this.isClaimCurrent(claim)
			|| claim.record.status !== "stored"
			|| !this.tokenMatchesClaim(token, claim)
		) return "stale";
		if (claim.bindingRequestAccepted) return "accepted";
		const current = this.editorBindings.captureCurrentTargetReadyToken({
			sessionId: claim.request.sessionId,
			expectedGeneration: claim.request.expectedGeneration,
			targetPath: claim.intent.targetPath,
			targetFile: claim.intent.targetFile,
		});
		if (current !== token) return "stale";
		const accepted = claim.request.deliver({
			type: "recovery-target-binding-requested",
			sessionId: claim.request.sessionId,
			expectedGeneration: claim.request.expectedGeneration,
			recoveryOperationEpoch: claim.request.recoveryOperationEpoch,
			intentId: claim.intent.intentId,
			recordId: claim.record.recordId,
		});
		if (!accepted) return "rejected";
		if (!this.isClaimCurrent(claim)) return "stale";
		claim.bindingRequestAccepted = true;
		return "accepted";
	}

	private tokenMatchesClaim(
		token: TargetReadyToken,
		claim: LiveHandoffReplayClaim,
	): boolean {
		return token.sessionId === claim.request.sessionId
			&& token.handoffGeneration === claim.request.expectedGeneration
			&& token.switchIntentSeq === claim.intent.switchIntentSeq
			&& token.targetPath === claim.intent.targetPath
			&& token.targetFile === claim.intent.targetFile;
	}

	private async resumeClaim(claim: LiveHandoffReplayClaim): Promise<void> {
		if (!this.isClaimCurrent(claim) || claim.record.status !== "stored") return;
		const token = claim.latestTargetReadyToken;
		if (!token || token === claim.lastAttemptedTargetReadyToken) return;
		claim.lastAttemptedTargetReadyToken = token;
		const planned = await this.controller.requestExactHandoffReplayPlan({
			sessionId: claim.request.sessionId,
			expectedGeneration: claim.request.expectedGeneration,
			recoveryOperationEpoch: claim.request.recoveryOperationEpoch,
			intent: claim.intent,
			record: claim.record,
			targetReadyToken: token,
			compositionProof: claim.compositionProof,
		});
		if (!this.isClaimCurrent(claim) || claim.record.status !== "stored") return;
		if (planned.kind === "manual") {
			await this.demoteRecord(claim.request, claim.record, claim, true);
			return;
		}
		if (planned.kind === "replan") {
			const current = this.editorBindings.captureCurrentTargetReadyToken({
				sessionId: claim.request.sessionId,
				expectedGeneration: claim.request.expectedGeneration,
				targetPath: claim.intent.targetPath,
				targetFile: claim.intent.targetFile,
			});
			if (current && current !== token) {
				claim.latestTargetReadyToken = current;
				this.enqueue(claim, () => this.resumeClaim(claim));
			} else {
				await this.demoteRecord(claim.request, claim.record, claim, true);
			}
			return;
		}

		let witnessResult: HandoffRecoveryCasResult | null = null;
		try {
			witnessResult = await this.store.storeApplyWitness(
				claim.record.recordId,
				claim.record.checksum,
				planned.applyWitness,
			);
		} catch {
			// Exact reread below determines whether the mutation committed.
		}
		if (!this.isClaimCurrent(claim)) return;
		const pending = await this.acceptWitnessMutation(
			claim,
			planned.applyWitness,
			witnessResult,
		);
		if (!pending || !this.isClaimCurrent(claim)) return;
		claim.record = pending;
		const delivered = this.deliver(claim.request, {
			kind: "replay-pending",
			intentId: claim.intent.intentId,
			recordId: pending.recordId,
		});
		if (!delivered || !this.isClaimCurrent(claim)) {
			if (this.isClaimCurrent(claim)) {
				await this.demoteRecord(claim.request, pending, claim, true);
			}
			return;
		}

		// Deliberately no await/callback between accepted permit and dispatch.
		const consumed = this.controller.consumeExactHandoffReplayPermit({
			plan: planned.plan,
			record: pending,
			recoveryOperationEpoch: claim.request.recoveryOperationEpoch,
		});
		if (consumed.kind !== "accepted") {
			await this.demoteRecord(claim.request, pending, claim, true);
			return;
		}
		const dispatched = this.editorBindings.applyExactHandoffReplay({
			plan: planned.plan,
			permit: consumed.permit,
			record: pending,
			recoveryOperationEpoch: claim.request.recoveryOperationEpoch,
		});
		if (dispatched.kind !== "applied") {
			if (dispatched.kind === "dispatched-uncertain") claim.dispatchOccurred = true;
			await this.demoteRecord(claim.request, pending, claim, true);
			return;
		}
		claim.dispatchOccurred = true;
		const receipt = this.controller.createExactHandoffReplayDispatchReceipt({
			plan: planned.plan,
			record: pending,
			recoveryOperationEpoch: claim.request.recoveryOperationEpoch,
			postcondition: dispatched.postcondition,
			appliedAt: this.now(),
		});
		if (!receipt) {
			await this.demoteRecord(claim.request, pending, claim, true);
			return;
		}
		claim.receipt = receipt;
		try {
			claim.receiptHash = await hashHandoffRecoveryDispatchReceipt(
				receipt as unknown as Readonly<
					Record<string, string | number | boolean | null>
				>,
			);
		} catch {
			await this.demoteRecord(claim.request, pending, claim, true);
			return;
		}
		if (!this.isClaimCurrent(claim)) return;

		let receiptResult: HandoffRecoveryCasResult | null = null;
		try {
			receiptResult = await this.store.storeDispatchReceipt(
				pending.recordId,
				pending.checksum,
				claim.receiptHash,
			);
		} catch {
			// Exact reread below proves or rejects the receipt commit.
		}
		if (!this.isClaimCurrent(claim)) return;
		const awaiting = await this.acceptReceiptMutation(claim, receiptResult);
		if (!awaiting || !this.isClaimCurrent(claim)) return;
		claim.record = awaiting;
		if (!this.deliver(claim.request, {
			kind: "replayed-awaiting-settlement",
			intentId: claim.intent.intentId,
			recordId: awaiting.recordId,
		})) {
			this.retireClaim(claim);
			return;
		}
		await this.observeLiveSettlement(claim);
	}

	private async acceptWitnessMutation(
		claim: LiveHandoffReplayClaim,
		witness: HandoffRecoveryApplyWitness,
		result: HandoffRecoveryCasResult | null,
	): Promise<ReplayPendingRecord | null> {
		if (
			result
			&& (result.kind === "updated" || result.kind === "unchanged")
			&& await this.isExactReplayPending(result, claim, witness)
		) {
			return result.record as ReplayPendingRecord;
		}
		const converged = await this.convergeReplayStoreMutation(
			claim.record.recordId,
			claim.intentEnvelopeHash,
			null,
		);
		if (
			converged.kind === "replay-pending"
			&& this.sameWitness(converged.record.applyWitness, witness)
		) return converged.record;
		if (converged.kind === "stored") {
			await this.demoteRecord(claim.request, converged.record, claim, true);
			return null;
		}
		await this.finishConvergence(claim.request, converged, claim);
		return null;
	}

	private async acceptReceiptMutation(
		claim: LiveHandoffReplayClaim,
		result: HandoffRecoveryCasResult | null,
	): Promise<AwaitingRecord | null> {
		if (
			result
			&& (result.kind === "updated" || result.kind === "unchanged")
			&& await this.isExactAwaiting(result, claim)
		) {
			return result.record as AwaitingRecord;
		}
		const converged = await this.convergeReplayStoreMutation(
			claim.record.recordId,
			claim.intentEnvelopeHash,
			claim.receiptHash,
		);
		if (
			converged.kind === "awaiting"
			&& converged.record.applyWitness?.dispatchReceiptHash === claim.receiptHash
		) return converged.record;
		if (converged.kind === "replay-pending") {
			await this.demoteRecord(claim.request, converged.record, claim, true);
			return null;
		}
		await this.finishConvergence(claim.request, converged, claim);
		return null;
	}

	private async observeLiveSettlement(claim: LiveHandoffReplayClaim): Promise<void> {
		if (
			!this.isClaimCurrent(claim)
			|| claim.record.status !== "replayed-awaiting-settlement"
			|| claim.receipt === null
		) return;
		const observation = await this.controller.observeExactHandoffReplaySettlement({
			record: claim.record,
			mode: "live",
			receipt: claim.receipt,
		});
		if (!this.isClaimCurrent(claim) || claim.record.status !== "replayed-awaiting-settlement") {
			return;
		}
		if (observation.kind === "pending") return;
		if (observation.kind === "uncertain") {
			await this.demoteRecord(claim.request, claim.record, claim, true);
			return;
		}

		let finalized: Awaited<ReturnType<HandoffRecoveryStore["resolveRecord"]>> | null = null;
		try {
			finalized = await this.store.resolveRecord({
				kind: "finalize-active",
				recordId: claim.record.recordId,
				expectedChecksum: claim.record.checksum,
				disposition: "settled-replay",
				finalizedAt: this.now(),
			});
		} catch {
			// Exact reread below determines whether finalization committed.
		}
		if (!this.isClaimCurrent(claim)) return;
		const exactFinalized = Boolean(
			finalized
			&& (finalized.kind === "updated" || finalized.kind === "unchanged")
			&& await this.isExactSettledTerminal(finalized, claim)
		);
		if (!this.isClaimCurrent(claim)) return;
		if (exactFinalized && finalized
			&& (finalized.kind === "updated" || finalized.kind === "unchanged")) {
			this.deliverTerminal(claim.request, finalized.record as TerminalHandoffRecoveryReceipt);
			this.retireClaim(claim);
			return;
		}
		const converged = await this.convergeReplayStoreMutation(
			claim.record.recordId,
			claim.intentEnvelopeHash,
			claim.receiptHash,
		);
		if (!this.isClaimCurrent(claim)) return;
		if (converged.kind === "awaiting") {
			claim.record = converged.record;
			return;
		}
		await this.finishConvergence(claim.request, converged, claim);
	}

	private async observeHydratedSettlement(
		record: AwaitingRecord,
	): Promise<"settled" | "uncertain"> {
		const result = await this.controller.observeExactHandoffReplaySettlement({
			record,
			mode: "hydrated",
			receipt: null,
		});
		return result.kind === "settled" ? "settled" : "uncertain";
	}

	private async demoteRecord(
		request: HandoffRecoveryRuntimeRequest,
		record: StoredRecord | ReplayPendingRecord | AwaitingRecord,
		claim: LiveHandoffReplayClaim | null,
		retryAfterReread: boolean,
		actionFence: (() => boolean) | null = null,
	): Promise<void> {
		if (actionFence && !actionFence()) return;
		let result: HandoffRecoveryCasResult | null = null;
		try {
			result = await this.store.compareAndSetStatus(
				record.recordId,
				record.checksum,
				{ from: record.status, to: "needs-review" },
			);
		} catch {
			// Exact reread below determines whether the demotion committed.
		}
		if ((claim && !this.isClaimCurrent(claim)) || (actionFence && !actionFence())) {
			return;
		}
		const exactNeedsReview = result
			? await this.isExactNeedsReview(result, record.intentEnvelopeHash)
			: false;
		if ((claim && !this.isClaimCurrent(claim)) || (actionFence && !actionFence())) {
			return;
		}
		if (
			result
			&& (result.kind === "updated" || result.kind === "unchanged")
			&& exactNeedsReview
		) {
			this.deliverNeedsReview(request, result.record as NeedsReviewRecord);
			if (claim) this.retireClaim(claim);
			return;
		}
		const converged = await this.convergeReplayStoreMutation(
			record.recordId,
			record.intentEnvelopeHash,
			claim?.receiptHash ?? null,
		);
		if ((claim && !this.isClaimCurrent(claim)) || (actionFence && !actionFence())) {
			return;
		}
		if (
			retryAfterReread
			&& ((converged.kind === "stored" && record.status === "stored")
				|| (converged.kind === "replay-pending" && record.status === "replay-pending")
				|| (converged.kind === "awaiting"
					&& record.status === "replayed-awaiting-settlement"))
		) {
			await this.demoteRecord(
				request,
				converged.record,
				claim,
				false,
				actionFence,
			);
			return;
		}
		await this.finishConvergence(request, converged, claim, actionFence);
	}

	private async demoteConvergedRecord(
		request: HandoffRecoveryRuntimeRequest,
		converged: ReplayStoreConvergence,
		retryAfterReread: boolean,
		actionFence: (() => boolean) | null = null,
	): Promise<void> {
		if (actionFence && !actionFence()) return;
		if (
			converged.kind === "stored"
			|| converged.kind === "replay-pending"
			|| converged.kind === "awaiting"
		) {
			await this.demoteRecord(
				request,
				converged.record,
				null,
				retryAfterReread,
				actionFence,
			);
			return;
		}
		await this.finishConvergence(request, converged, null, actionFence);
	}

	private async demoteReplayPendingForClear(
		entry: RetiredClearClaim,
		record: ReplayPendingRecord,
		retryAfterReread: boolean,
	): Promise<void> {
		let result: HandoffRecoveryCasResult | null = null;
		try {
			result = await this.store.compareAndSetStatus(
				record.recordId,
				record.checksum,
				{ from: "replay-pending", to: "needs-review" },
			);
		} catch {
			// Exact reread below determines whether the Clear demotion committed.
		}
		if (result && await this.isExactNeedsReview(result, entry.intentEnvelopeHash)) return;
		const converged = await this.convergeReplayStoreMutation(
			entry.recordId,
			entry.intentEnvelopeHash,
			entry.receiptHash,
		);
		if (retryAfterReread && converged.kind === "replay-pending") {
			await this.demoteReplayPendingForClear(entry, converged.record, false);
		}
	}

	private async finishConvergence(
		request: HandoffRecoveryRuntimeRequest,
		converged: ReplayStoreConvergence,
		claim: LiveHandoffReplayClaim | null,
		actionFence: (() => boolean) | null = null,
	): Promise<void> {
		if (actionFence && !actionFence()) return;
		if (converged.kind === "needs-review") {
			this.deliverNeedsReview(request, converged.record);
			if (claim) this.retireClaim(claim);
			return;
		}
		if (converged.kind === "terminal") {
			this.deliverTerminal(request, converged.record);
			if (claim) this.retireClaim(claim);
			return;
		}
		if (converged.kind === "failed") {
			this.deliver(request, {
				kind: "failed",
				intentId: request.intent.intentId,
				reason: `recovery-store-${converged.reason}`,
			});
			if (claim) this.retireClaim(claim);
			return;
		}
		// An uncommitted ambiguous mutation stays visibly gated. Surface a
		// content-free failure without claiming that the gate was released.
		this.deliver(request, {
			kind: "failed",
			intentId: request.intent.intentId,
			reason: "recovery-store-write-unproved",
		});
		if (claim) this.retireClaim(claim);
	}

	private async convergeReplayStoreMutation(
		recordId: string,
		intentEnvelopeHash: string,
		localReceiptHash: string | null,
	): Promise<ReplayStoreConvergence> {
		if (!this.isScopeCurrent()) return { kind: "failed", reason: "scope-stale" };
		let hydration: Awaited<ReturnType<HandoffRecoveryStore["hydrateScope"]>>;
		try {
			hydration = await this.store.hydrateScope();
		} catch {
			return { kind: "failed", reason: "corrupt" };
		}
		if (!this.isScopeCurrent()) return { kind: "failed", reason: "scope-stale" };
		if (hydration.issues.some((issue) =>
			issue.recordId === null || issue.recordId === recordId)) {
			return { kind: "failed", reason: "corrupt" };
		}
		const matches = [...hydration.active, ...hydration.terminal]
			.filter((record) => record.recordId === recordId);
		if (matches.length === 0) return { kind: "failed", reason: "missing" };
		if (matches.length !== 1) return { kind: "failed", reason: "corrupt" };
		const record = matches[0]!;
		if (
			record.intentEnvelopeHash !== intentEnvelopeHash
			|| canonicalHandoffRecoveryJson(record.scope)
				!== canonicalHandoffRecoveryJson(this.store.scope)
		) return { kind: "failed", reason: "scope-stale" };
		try {
			if (await validateHandoffRecoveryRecord(record) !== record) {
				return { kind: "failed", reason: "corrupt" };
			}
		} catch {
			return { kind: "failed", reason: "corrupt" };
		}
		if (!isActiveHandoffRecoveryRecord(record)) {
			return { kind: "terminal", record };
		}
		switch (record.status) {
			case "stored": return { kind: "stored", record: record as StoredRecord };
			case "replay-pending":
				return { kind: "replay-pending", record: record as ReplayPendingRecord };
			case "replayed-awaiting-settlement":
				if (
					localReceiptHash !== null
					&& record.applyWitness?.dispatchReceiptHash !== localReceiptHash
				) return { kind: "failed", reason: "corrupt" };
				return { kind: "awaiting", record: record as AwaitingRecord };
			case "needs-review":
				return { kind: "needs-review", record: record as NeedsReviewRecord };
		}
	}

	private enqueue(claim: LiveHandoffReplayClaim, work: () => Promise<void>): void {
		const recordId = claim.record.recordId;
		const previous = this.tails.get(recordId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(async () => {
			if (!this.isClaimCurrent(claim)) return;
			try {
				await work();
			} catch {
				if (!this.isClaimCurrent(claim)) return;
				this.deliver(claim.request, {
					kind: "failed",
					intentId: claim.intent.intentId,
					reason: "recovery-runtime-failed",
				});
				this.retireClaim(claim);
			}
		}).finally(() => {
			if (this.tails.get(recordId) === next) this.tails.delete(recordId);
		});
		this.tails.set(recordId, next);
	}

	private enqueueRecordAction(
		recordId: string,
		isActionCurrent: () => boolean,
		work: () => Promise<void>,
	): Promise<void> {
		const previous = this.tails.get(recordId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(async () => {
			if (!isActionCurrent()) return;
			await work();
		}).finally(() => {
			if (this.tails.get(recordId) === next) this.tails.delete(recordId);
		});
		this.tails.set(recordId, next);
		return next;
	}

	private async drainTails(): Promise<void> {
		while (this.tails.size > 0) {
			await Promise.allSettled(Array.from(this.tails.values()));
		}
	}

	private isClaimCurrent(claim: LiveHandoffReplayClaim): boolean {
		return !claim.retired
			&& claim.actionEpoch === this.actionEpoch
			&& this.isScopeCurrent()
			&& this.claims.get(claim.record.recordId) === claim;
	}

	private retireClaim(claim: LiveHandoffReplayClaim): void {
		claim.retired = true;
		if (this.claims.get(claim.record.recordId) === claim) {
			this.claims.delete(claim.record.recordId);
		}
	}

	private deliver(
		request: HandoffRecoveryRuntimeRequest,
		intentState: HandoffIntentState,
	): boolean {
		if (!this.isScopeCurrent()) return false;
		return request.deliver({
			type: "intent-state-changed",
			sessionId: request.sessionId,
			expectedGeneration: request.expectedGeneration,
			recoveryOperationEpoch: request.recoveryOperationEpoch,
			intentState,
		});
	}

	private deliverNeedsReview(
		request: HandoffRecoveryRuntimeRequest,
		record: NeedsReviewRecord,
	): void {
		this.deliver(request, {
			kind: "needs-review",
			intentId: record.intentId,
			recordId: record.recordId,
		});
	}

	private deliverTerminal(
		request: HandoffRecoveryRuntimeRequest,
		record: TerminalHandoffRecoveryReceipt,
	): void {
		this.deliver(request, record.status === "resolved" ? {
			kind: "resolved",
			intentId: record.intentId,
			recordId: record.recordId,
		} : {
			kind: "discarded",
			intentId: record.intentId,
			recordId: record.recordId,
		});
	}

	private async isExactReplayPending(
		result: HandoffRecoveryCasResult,
		claim: LiveHandoffReplayClaim,
		witness: HandoffRecoveryApplyWitness,
	): Promise<boolean> {
		return (result.kind === "updated" || result.kind === "unchanged")
			&& isActiveHandoffRecoveryRecord(result.record)
			&& result.record.status === "replay-pending"
			&& result.record.recordId === claim.record.recordId
			&& result.record.intentId === claim.intent.intentId
			&& result.record.intentEnvelopeHash === claim.intentEnvelopeHash
			&& this.sameWitness(result.record.applyWitness, witness)
			&& await this.isVerifiedStoreRecord(result.record);
	}

	private async isExactAwaiting(
		result: HandoffRecoveryCasResult,
		claim: LiveHandoffReplayClaim,
	): Promise<boolean> {
		return (result.kind === "updated" || result.kind === "unchanged")
			&& isActiveHandoffRecoveryRecord(result.record)
			&& result.record.status === "replayed-awaiting-settlement"
			&& result.record.recordId === claim.record.recordId
			&& result.record.intentId === claim.intent.intentId
			&& result.record.intentEnvelopeHash === claim.intentEnvelopeHash
			&& result.record.applyWitness?.dispatchReceiptHash === claim.receiptHash
			&& await this.isVerifiedStoreRecord(result.record);
	}

	private async isExactNeedsReview(
		result: HandoffRecoveryCasResult,
		intentEnvelopeHash: string,
	): Promise<boolean> {
		return (result.kind === "updated" || result.kind === "unchanged")
			&& isActiveHandoffRecoveryRecord(result.record)
			&& result.record.status === "needs-review"
			&& result.record.intentEnvelopeHash === intentEnvelopeHash
			&& await this.isVerifiedStoreRecord(result.record);
	}

	private async isExactSettledTerminal(
		result: Awaited<ReturnType<HandoffRecoveryStore["resolveRecord"]>>,
		claim: LiveHandoffReplayClaim,
	): Promise<boolean> {
		return (result.kind === "updated" || result.kind === "unchanged")
			&& !isActiveHandoffRecoveryRecord(result.record)
			&& result.record.status === "resolved"
			&& result.record.disposition === "settled-replay"
			&& result.record.recordId === claim.record.recordId
			&& result.record.intentId === claim.intent.intentId
			&& result.record.intentEnvelopeHash === claim.intentEnvelopeHash
			&& await this.isVerifiedStoreRecord(result.record);
	}

	private async isVerifiedStoreRecord(record: HandoffRecoveryRecord): Promise<boolean> {
		try {
			return canonicalHandoffRecoveryJson(record.scope)
				=== canonicalHandoffRecoveryJson(this.store.scope)
				&& await this.validateRecord(record) === record;
		} catch {
			return false;
		}
	}

	private sameWitness(
		left: HandoffRecoveryApplyWitness | null,
		right: HandoffRecoveryApplyWitness,
	): boolean {
		try {
			return left !== null
				&& canonicalHandoffRecoveryJson(left)
					=== canonicalHandoffRecoveryJson(right);
		} catch {
			return false;
		}
	}

	private async findIntentEnvelopeHash(
		recordId: string,
		intentId: string,
	): Promise<string | null> {
		try {
			const hydration = await this.store.hydrateScope();
			if (!this.isScopeCurrent()) return null;
			const records = [...hydration.active, ...hydration.terminal]
				.filter((record) => record.recordId === recordId && record.intentId === intentId);
			return records.length === 1 ? records[0]!.intentEnvelopeHash : null;
		} catch {
			return null;
		}
	}
}
