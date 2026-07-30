import type {
	EditorHandoffEvent,
	HandoffInputIntent,
	ManagedLeafSession,
} from "../sync/editorHandoffState";
import {
	buildHandoffRecoveryRecordId,
	canonicalHandoffRecoveryJson,
	isActiveHandoffRecoveryRecord,
	validateHandoffRecoveryRecord,
	type ActiveHandoffRecoveryRecord,
	type ClearHandoffRecoveryScopeResult,
	type HandoffRecoveryCasResult,
	type HandoffRecoveryHydrationResult,
	type HandoffRecoveryRecord,
	type HandoffRecoveryStore,
	type PutHandoffRecoveryIntentResult,
	type ResolveHandoffRecoveryResult,
	type TerminalHandoffRecoveryReceipt,
} from "../sync/handoffRecoveryStore";
import type { DashboardHandoffRecovery } from "../dashboard/dashboardTypes";

export type HandoffIntentState = NonNullable<
	ManagedLeafSession["handoff"]
>["intentState"];

export type IntentStateChangedEvent = Extract<
	EditorHandoffEvent,
	{ type: "intent-state-changed" }
>;

export type HandoffRecoveryDeliveryEvent =
	| IntentStateChangedEvent
	| Extract<
		EditorHandoffEvent,
		{ type: "recovery-target-binding-requested" }
	>;

export interface HandoffRecoveryRuntimeRequest {
	sessionId: string;
	expectedGeneration: number;
	recoveryOperationEpoch: number;
	intent: HandoffInputIntent;
	deliver(event: HandoffRecoveryDeliveryEvent): boolean;
}

export interface HandoffRecoveryPort {
	persistAndClassify(request: HandoffRecoveryRuntimeRequest): Promise<void>;
	copyAndContinue(
		request: HandoffRecoveryRuntimeRequest,
		writeClipboard: (text: string) => Promise<void>,
	): Promise<void>;
	exportAndContinue(
		request: HandoffRecoveryRuntimeRequest,
		exportVerified: (text: string) => Promise<void>,
	): Promise<void>;
	discardAndContinue(request: HandoffRecoveryRuntimeRequest): Promise<void>;
	continueWithoutAutomaticApply(request: HandoffRecoveryRuntimeRequest): Promise<void>;
	retrySettlement(request: HandoffRecoveryRuntimeRequest): Promise<void>;
	collectDashboardHandoffRecovery(): Promise<DashboardHandoffRecovery>;
	resolveManually(
		recordId: string,
		expectedChecksum: string,
	): Promise<TerminalHandoffRecoveryReceipt>;
	discardRecord(
		recordId: string,
		expectedChecksum: string,
	): Promise<TerminalHandoffRecoveryReceipt>;
	hydrateScope(): Promise<HandoffRecoveryHydrationResult>;
	getRecord(
		recordId: string,
		expectedChecksum: string,
	): Promise<HandoffRecoveryRecord>;
	clearCurrentScope(): Promise<ClearHandoffRecoveryScopeResult>;
	drain(): Promise<void>;
}

export interface HandoffRecoveryReplayActions {
	continueWithoutAutomaticApply(
		request: HandoffRecoveryRuntimeRequest,
		recordId: string,
		isActionCurrent: () => boolean,
	): Promise<void>;
	retrySettlement(recordId: string): void;
}

export interface HandoffRecoveryCoordinatorDeps {
	store: HandoffRecoveryStore;
	now?: () => number;
	isScopeCurrent(): boolean;
	classifyStoredIntent?: HandoffStoredIntentClassifier;
	observeAwaitingSettlement?: HandoffAwaitingSettlementObserver;
	/** Slice 2 compatibility alias retained for existing callers. */
	observeSettlement?: HandoffAwaitingSettlementObserver;
	replayActions?: HandoffRecoveryReplayActions;
	clearHooks?: HandoffRecoveryClearHooks;
}

export interface HandoffRecoveryClearHooks {
	invalidateReplayAuthorityBeforeClear(): void;
	drainAndDemoteReplayRowsBeforeClear(): Promise<void>;
}

export type HandoffStoredIntentClassifier = (
	request: HandoffRecoveryRuntimeRequest,
	record: ActiveHandoffRecoveryRecord & Readonly<{ status: "stored" }>,
) => Promise<"claimed" | "manual">;

export type HandoffAwaitingSettlementObserver = (
	record: ActiveHandoffRecoveryRecord & Readonly<{
		status: "replayed-awaiting-settlement";
	}>,
) => Promise<"settled" | "uncertain">;

export type HandoffRecoverySettlementObserver = HandoffAwaitingSettlementObserver;

type HandoffRecoveryIntentActionToken = Readonly<{
	scopeEpoch: number;
	intentId: string;
	intentEpoch: number;
}>;

type HydratedRecordConvergence =
	| { kind: "active"; record: ActiveHandoffRecoveryRecord }
	| { kind: "terminal"; record: TerminalHandoffRecoveryReceipt }
	| { kind: "failed"; reason: "missing" | "corrupt" | "scope-stale" };

export class ManualHandoffRecoveryCoordinator implements HandoffRecoveryPort {
	private readonly store: HandoffRecoveryStore;
	private readonly now: () => number;
	private readonly isScopeCurrent: () => boolean;
	private readonly classifyStoredIntent: HandoffStoredIntentClassifier;
	private readonly observeSettlement: HandoffAwaitingSettlementObserver;
	private readonly replayActions: HandoffRecoveryReplayActions | null;
	private readonly clearHooks: HandoffRecoveryClearHooks;
	private actionEpoch = 0;
	private readonly intentActionEpochs = new Map<string, number>();

	constructor(deps: HandoffRecoveryCoordinatorDeps) {
		this.store = deps.store;
		this.now = deps.now ?? (() => Date.now());
		this.isScopeCurrent = () => deps.isScopeCurrent();
		this.classifyStoredIntent = deps.classifyStoredIntent ?? (async () => "manual");
		this.observeSettlement = deps.observeAwaitingSettlement
			?? deps.observeSettlement
			?? (async () => "uncertain");
		this.replayActions = deps.replayActions ?? null;
		this.clearHooks = deps.clearHooks ?? {
			invalidateReplayAuthorityBeforeClear() {},
			async drainAndDemoteReplayRowsBeforeClear() {},
		};
	}

	async persistAndClassify(request: HandoffRecoveryRuntimeRequest): Promise<void> {
		const actionToken = this.beginIntentAction(request);
		if (!this.isIntentActionCurrent(actionToken)) return;
		this.deliver(request, {
			kind: "persisting",
			intentId: request.intent.intentId,
		}, actionToken);
		try {
			const put = await this.store.putIntent(request.intent);
			if (!this.isIntentActionCurrent(actionToken)) return;
			if (put.kind === "fenced") {
				await this.finishFencedPut(request, put, actionToken);
				return;
			}
			if (!isActiveHandoffRecoveryRecord(put.record)) {
				this.deliverTerminal(request, put.record, actionToken);
				return;
			}
			let active = put.record;
			this.deliver(request, {
				kind: active.status === "needs-review" ? "needs-review" : "stored",
				intentId: active.intentId,
				recordId: active.recordId,
			}, actionToken);
			if (put.kind === "stored" && active.status === "stored") {
				const classification = await this.classifyStoredIntent(
					request,
					active as ActiveHandoffRecoveryRecord & Readonly<{ status: "stored" }>,
				);
				if (!this.isIntentActionCurrent(actionToken)) return;
				if (classification === "claimed") return;
			}
			if (active.status !== "needs-review") {
				const transition = await this.store.compareAndSetStatus(
					active.recordId,
					active.checksum,
					{ from: active.status, to: "needs-review" },
				);
				if (!this.isIntentActionCurrent(actionToken)) return;
				active = await this.requireNeedsReview(active.recordId, transition);
				if (!this.isIntentActionCurrent(actionToken)) return;
			}
			this.deliver(request, {
				kind: "needs-review",
				intentId: active.intentId,
				recordId: active.recordId,
			}, actionToken);
		} catch (error) {
			if (!this.isIntentActionCurrent(actionToken)) return;
			this.deliver(request, {
				kind: "failed",
				intentId: request.intent.intentId,
				reason: classifyRecoveryFailure(error),
			}, actionToken);
		}
	}

	async copyAndContinue(
		request: HandoffRecoveryRuntimeRequest,
		writeClipboard: (text: string) => Promise<void>,
	): Promise<void> {
		const actionToken = this.beginIntentAction(request);
		if (!this.isIntentActionCurrent(actionToken)) return;
		this.deliver(request, {
			kind: "escape-pending",
			intentId: request.intent.intentId,
			action: "copy",
		}, actionToken);
		try {
			await writeClipboard(request.intent.afterContent);
			if (!this.isIntentActionCurrent(actionToken)) return;
			const outcome = await this.store.resolveRecord({
				kind: "precommit-escape",
				intentId: request.intent.intentId,
				action: "copy",
			});
			if (!this.isIntentActionCurrent(actionToken)) return;
			await this.finishExplicitEscape(request, "copy", outcome, actionToken);
		} catch (error) {
			if (!this.isIntentActionCurrent(actionToken)) return;
			this.deliver(request, {
				kind: "failed",
				intentId: request.intent.intentId,
				reason: classifyRecoveryFailure(error),
			}, actionToken);
		}
	}

	async exportAndContinue(
		request: HandoffRecoveryRuntimeRequest,
		exportVerified: (text: string) => Promise<void>,
	): Promise<void> {
		const actionToken = this.beginIntentAction(request);
		if (!this.isIntentActionCurrent(actionToken)) return;
		this.deliver(request, {
			kind: "escape-pending",
			intentId: request.intent.intentId,
			action: "export",
		}, actionToken);
		try {
			await exportVerified(request.intent.afterContent);
			if (!this.isIntentActionCurrent(actionToken)) return;
			const outcome = await this.store.resolveRecord({
				kind: "precommit-escape",
				intentId: request.intent.intentId,
				action: "export",
			});
			if (!this.isIntentActionCurrent(actionToken)) return;
			await this.finishExplicitEscape(request, "export", outcome, actionToken);
		} catch (error) {
			if (!this.isIntentActionCurrent(actionToken)) return;
			this.deliver(request, {
				kind: "failed",
				intentId: request.intent.intentId,
				reason: classifyRecoveryFailure(error),
			}, actionToken);
		}
	}

	async discardAndContinue(request: HandoffRecoveryRuntimeRequest): Promise<void> {
		const actionToken = this.beginIntentAction(request);
		if (!this.isIntentActionCurrent(actionToken)) return;
		try {
			const outcome = await this.store.resolveRecord({
				kind: "precommit-escape",
				intentId: request.intent.intentId,
				action: "discard",
			});
			if (!this.isIntentActionCurrent(actionToken)) return;
			await this.finishExplicitEscape(request, "discard", outcome, actionToken);
		} catch (error) {
			if (!this.isIntentActionCurrent(actionToken)) return;
			this.deliver(request, {
				kind: "failed",
				intentId: request.intent.intentId,
				reason: classifyRecoveryFailure(error),
			}, actionToken);
		}
	}

	async continueWithoutAutomaticApply(
		request: HandoffRecoveryRuntimeRequest,
	): Promise<void> {
		if (!this.isScopeCurrent()) return;
		const actionToken = this.beginIntentAction(request);
		if (this.replayActions) {
			await this.replayActions.continueWithoutAutomaticApply(
				request,
				buildHandoffRecoveryRecordId(this.store.scope, request.intent.intentId),
				() => this.isIntentActionCurrent(actionToken),
			);
			return;
		}
		try {
			const hydration = await this.store.hydrateScope();
			if (!this.isIntentActionCurrent(actionToken)) return;
			const terminal = hydration.terminal.find(
				(record) => record.intentId === request.intent.intentId,
			);
			if (terminal) {
				this.deliverTerminal(request, terminal, actionToken);
				return;
			}
			const active = hydration.active.find(
				(record) => record.intentId === request.intent.intentId,
			);
			if (!active) throw new Error("Recovery record is missing");
			const manual = active.status === "needs-review"
				? active
				: await this.requireNeedsReview(
					active.recordId,
					await this.store.compareAndSetStatus(
						active.recordId,
						active.checksum,
						{ from: active.status, to: "needs-review" },
					),
				);
			if (!this.isIntentActionCurrent(actionToken)) return;
			this.deliver(request, {
				kind: "needs-review",
				intentId: manual.intentId,
				recordId: manual.recordId,
			}, actionToken);
		} catch {
			// The existing stored/replay gate remains closed and retryable.
		}
	}

	async retrySettlement(request: HandoffRecoveryRuntimeRequest): Promise<void> {
		if (!this.isScopeCurrent()) return;
		const actionToken = this.beginIntentAction(request);
		if (this.replayActions) {
			this.replayActions.retrySettlement(
				buildHandoffRecoveryRecordId(this.store.scope, request.intent.intentId),
			);
			return;
		}
		try {
			const hydration = await this.store.hydrateScope();
			if (!this.isIntentActionCurrent(actionToken)) return;
			const active = hydration.active.find(
				(record) => record.intentId === request.intent.intentId,
			);
			if (!active) return;
			if (active.status !== "replayed-awaiting-settlement") {
				if (active.status === "needs-review") {
					this.deliver(request, {
						kind: "needs-review",
						intentId: active.intentId,
						recordId: active.recordId,
					}, actionToken);
				}
				return;
			}
			const manual = await this.requireNeedsReview(
				active.recordId,
				await this.store.compareAndSetStatus(
					active.recordId,
					active.checksum,
					{ from: "replayed-awaiting-settlement", to: "needs-review" },
				),
			);
			if (!this.isIntentActionCurrent(actionToken)) return;
			this.deliver(request, {
				kind: "needs-review",
				intentId: manual.intentId,
				recordId: manual.recordId,
			}, actionToken);
		} catch {
			// Observation/CAS uncertainty keeps the settlement gate in place.
		}
	}

	async collectDashboardHandoffRecovery(): Promise<DashboardHandoffRecovery> {
		const hydration = await this.hydrateScope();
		return {
			status: hydration.status === "degraded" || hydration.issues.length > 0
				? "degraded"
				: "ready",
			activeCount: hydration.active.length,
			terminalCount: hydration.terminal.length,
			totalBytes: hydration.totalBytes,
			issues: hydration.issues.map((issue) => ({
				kind: issue.kind,
				recordId: issue.recordId,
			})),
			items: hydration.active
				.filter((record): record is ActiveHandoffRecoveryRecord & Readonly<{
					status: "needs-review" | "replayed-awaiting-settlement";
				}> =>
					record.status === "needs-review"
					|| record.status === "replayed-awaiting-settlement")
				.map((record) => ({
					recordId: record.recordId,
					intentId: record.intentId,
					expectedChecksum: record.checksum,
					fromPath: record.fromPath,
					targetPath: record.targetPath,
					originKind: record.originKind,
					sequenceBegan: record.sequenceBegan,
					status: record.status,
					capturedAt: record.capturedAt,
					storedAt: record.storedAt,
					startContentHash: record.startContentHash,
					afterContentHash: record.afterContentHash,
					startLength: record.body.startContent.length,
					afterLength: record.body.afterContent.length,
				}))
				.sort((left, right) =>
					right.storedAt - left.storedAt
					|| left.recordId.localeCompare(right.recordId)),
		};
	}

	async resolveManually(
		recordId: string,
		expectedChecksum: string,
	): Promise<TerminalHandoffRecoveryReceipt> {
		return this.finalizeDashboardRecord(
			recordId,
			expectedChecksum,
			"manual-resolution",
		);
	}

	async discardRecord(
		recordId: string,
		expectedChecksum: string,
	): Promise<TerminalHandoffRecoveryReceipt> {
		return this.finalizeDashboardRecord(recordId, expectedChecksum, "discard");
	}

	async hydrateScope(): Promise<HandoffRecoveryHydrationResult> {
		const actionEpoch = this.actionEpoch;
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope is not current");
		}
		const initial = await this.store.hydrateScope();
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope changed during hydration");
		}
		for (const record of initial.active) {
			if (record.status === "needs-review") continue;
			if (record.status === "replayed-awaiting-settlement") {
				const observation = await this.observeSettlement(
					record as ActiveHandoffRecoveryRecord & Readonly<{
						status: "replayed-awaiting-settlement";
					}>,
				);
				if (!this.isCurrent(actionEpoch)) {
					throw new Error("Handoff Recovery scope changed during settlement observation");
				}
				if (observation === "settled") {
					await this.finalizeHydratedSettlement(
						record as ActiveHandoffRecoveryRecord & Readonly<{
							status: "replayed-awaiting-settlement";
						}>,
						actionEpoch,
					);
					continue;
				}
			}
			await this.demoteHydratedRecord(
				record as ActiveHandoffRecoveryRecord & Readonly<{
					status: "stored" | "replay-pending" | "replayed-awaiting-settlement";
				}>,
				actionEpoch,
				true,
			);
		}
		const refreshed = await this.store.hydrateScope();
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope changed after hydration");
		}
		return refreshed;
	}

	async getRecord(
		recordId: string,
		expectedChecksum: string,
	): Promise<HandoffRecoveryRecord> {
		const actionEpoch = this.actionEpoch;
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope is not current");
		}
		const hydration = await this.store.hydrateScope();
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope changed during record load");
		}
		const record = [...hydration.active, ...hydration.terminal]
			.find((candidate) => candidate.recordId === recordId);
		if (!record || record.checksum !== expectedChecksum) {
			throw new Error("Handoff Recovery record is missing or stale");
		}
		return record;
	}

	async clearCurrentScope(): Promise<ClearHandoffRecoveryScopeResult> {
		this.actionEpoch += 1;
		const actionEpoch = this.actionEpoch;
		this.clearHooks.invalidateReplayAuthorityBeforeClear();
		await this.drain();
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope changed during clear");
		}
		await this.clearHooks.drainAndDemoteReplayRowsBeforeClear();
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope changed during clear");
		}
		return this.store.clearScope();
	}

	async drain(): Promise<void> {
		await this.store.drain();
	}

	private async finalizeDashboardRecord(
		recordId: string,
		expectedChecksum: string,
		disposition: "manual-resolution" | "discard",
	): Promise<TerminalHandoffRecoveryReceipt> {
		const actionEpoch = this.actionEpoch;
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope is not current");
		}
		const result = await this.store.resolveRecord({
			kind: "finalize-active",
			recordId,
			expectedChecksum,
			disposition,
			finalizedAt: this.now(),
		});
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope changed during finalization");
		}
		if (
			(result.kind !== "updated" && result.kind !== "unchanged")
			|| isActiveHandoffRecoveryRecord(result.record)
			|| (disposition === "manual-resolution" && result.record.status !== "resolved")
			|| (disposition === "discard" && result.record.status !== "discarded")
		) {
			throw new Error("Handoff Recovery record is missing or stale");
		}
		return result.record;
	}

	private isCurrent(actionEpoch: number): boolean {
		return actionEpoch === this.actionEpoch && this.isScopeCurrent();
	}

	private async finalizeHydratedSettlement(
		record: ActiveHandoffRecoveryRecord & Readonly<{
			status: "replayed-awaiting-settlement";
		}>,
		actionEpoch: number,
	): Promise<void> {
		let result: ResolveHandoffRecoveryResult | null = null;
		try {
			result = await this.store.resolveRecord({
				kind: "finalize-active",
				recordId: record.recordId,
				expectedChecksum: record.checksum,
				disposition: "settled-replay",
				finalizedAt: this.now(),
			});
		} catch {
			// Exact reread below distinguishes a committed finalization from no commit.
		}
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope changed during settlement finalization");
		}
		if (
			result
			&& (result.kind === "updated" || result.kind === "unchanged")
			&& await this.isExactHydratedSettledReceipt(result.record, record)
		) return;
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope changed during settlement verification");
		}
		const converged = await this.convergeHydratedRecord(record);
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope changed during settlement reread");
		}
		if (converged.kind === "terminal") return;
		if (
			converged.kind === "active"
			&& (converged.record.status === "replayed-awaiting-settlement"
				|| converged.record.status === "needs-review")
		) return;
		throw new Error(`Settled Recovery finalization is ${
			converged.kind === "failed" ? converged.reason : "inconsistent"
		}`);
	}

	private async demoteHydratedRecord(
		record: ActiveHandoffRecoveryRecord & Readonly<{
			status: "stored" | "replay-pending" | "replayed-awaiting-settlement";
		}>,
		actionEpoch: number,
		retryAfterReread: boolean,
	): Promise<void> {
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
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope changed during manual hydration");
		}
		if (
			result
			&& (result.kind === "updated" || result.kind === "unchanged")
			&& await this.isExactHydratedNeedsReview(result.record, record)
		) return;
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope changed during demotion verification");
		}
		const converged = await this.convergeHydratedRecord(record);
		if (!this.isCurrent(actionEpoch)) {
			throw new Error("Handoff Recovery scope changed during demotion reread");
		}
		if (converged.kind === "terminal") return;
		if (converged.kind === "active" && converged.record.status === "needs-review") {
			return;
		}
		if (
			retryAfterReread
			&& converged.kind === "active"
			&& converged.record.status === record.status
		) {
			await this.demoteHydratedRecord(
				converged.record as ActiveHandoffRecoveryRecord & Readonly<{
					status: "stored" | "replay-pending" | "replayed-awaiting-settlement";
				}>,
				actionEpoch,
				false,
			);
			return;
		}
		throw new Error(`Handoff Recovery demotion is ${
			converged.kind === "failed" ? converged.reason : "inconsistent"
		}`);
	}

	private async convergeHydratedRecord(
		reference: HandoffRecoveryRecord,
	): Promise<HydratedRecordConvergence> {
		let hydration: HandoffRecoveryHydrationResult;
		try {
			hydration = await this.store.hydrateScope();
		} catch {
			return { kind: "failed", reason: "corrupt" };
		}
		if (!this.isScopeCurrent()) return { kind: "failed", reason: "scope-stale" };
		if (hydration.issues.some((issue) =>
			issue.recordId === null || issue.recordId === reference.recordId)) {
			return { kind: "failed", reason: "corrupt" };
		}
		const matches = [...hydration.active, ...hydration.terminal]
			.filter((candidate) => candidate.recordId === reference.recordId);
		if (matches.length === 0) return { kind: "failed", reason: "missing" };
		if (matches.length !== 1) return { kind: "failed", reason: "corrupt" };
		const candidate = matches[0]!;
		if (!await this.isExactHydratedIdentity(candidate, reference)) {
			return { kind: "failed", reason: "scope-stale" };
		}
		return isActiveHandoffRecoveryRecord(candidate)
			? { kind: "active", record: candidate }
			: { kind: "terminal", record: candidate };
	}

	private async isExactHydratedNeedsReview(
		candidate: HandoffRecoveryRecord,
		reference: HandoffRecoveryRecord,
	): Promise<boolean> {
		return isActiveHandoffRecoveryRecord(candidate)
			&& candidate.status === "needs-review"
			&& await this.isExactHydratedIdentity(candidate, reference);
	}

	private async isExactHydratedSettledReceipt(
		candidate: HandoffRecoveryRecord,
		reference: HandoffRecoveryRecord,
	): Promise<boolean> {
		return !isActiveHandoffRecoveryRecord(candidate)
			&& candidate.status === "resolved"
			&& candidate.disposition === "settled-replay"
			&& await this.isExactHydratedIdentity(candidate, reference);
	}

	private async isExactHydratedIdentity(
		candidate: HandoffRecoveryRecord,
		reference: HandoffRecoveryRecord,
	): Promise<boolean> {
		try {
			return candidate.recordId === reference.recordId
				&& candidate.intentId === reference.intentId
				&& candidate.intentEnvelopeHash === reference.intentEnvelopeHash
				&& canonicalHandoffRecoveryJson(candidate.scope)
					=== canonicalHandoffRecoveryJson(this.store.scope)
				&& await validateHandoffRecoveryRecord(candidate) === candidate;
		} catch {
			return false;
		}
	}

	private beginIntentAction(
		request: HandoffRecoveryRuntimeRequest,
	): HandoffRecoveryIntentActionToken {
		const intentId = request.intent.intentId;
		const intentEpoch = (this.intentActionEpochs.get(intentId) ?? 0) + 1;
		this.intentActionEpochs.set(intentId, intentEpoch);
		return Object.freeze({
			scopeEpoch: this.actionEpoch,
			intentId,
			intentEpoch,
		});
	}

	private isIntentActionCurrent(token: HandoffRecoveryIntentActionToken): boolean {
		return this.isCurrent(token.scopeEpoch)
			&& this.intentActionEpochs.get(token.intentId) === token.intentEpoch;
	}

	private deliver(
		request: HandoffRecoveryRuntimeRequest,
		intentState: HandoffIntentState,
		actionToken: HandoffRecoveryIntentActionToken,
	): boolean {
		if (!this.isIntentActionCurrent(actionToken)) return false;
		return request.deliver(this.event(request, intentState));
	}

	private event(
		request: HandoffRecoveryRuntimeRequest,
		intentState: HandoffIntentState,
	): IntentStateChangedEvent {
		return {
			type: "intent-state-changed",
			sessionId: request.sessionId,
			expectedGeneration: request.expectedGeneration,
			recoveryOperationEpoch: request.recoveryOperationEpoch,
			intentState,
		};
	}

	private async requireNeedsReview(
		recordId: string,
		result: HandoffRecoveryCasResult,
	): Promise<ActiveHandoffRecoveryRecord & Readonly<{ status: "needs-review" }>> {
		if (
			(result.kind === "updated" || result.kind === "unchanged")
			&& isActiveHandoffRecoveryRecord(result.record)
			&& result.record.status === "needs-review"
		) {
			return result.record as ActiveHandoffRecoveryRecord & Readonly<{
				status: "needs-review";
			}>;
		}
		if (result.kind === "stale") {
			const hydration = await this.store.hydrateScope();
			const current = hydration.active.find((record) => record.recordId === recordId);
			if (current?.status === "needs-review") {
				return current as ActiveHandoffRecoveryRecord & Readonly<{
					status: "needs-review";
				}>;
			}
		}
		throw new Error("Recovery record did not reach needs-review");
	}

	private async finishFencedPut(
		request: HandoffRecoveryRuntimeRequest,
		put: Extract<PutHandoffRecoveryIntentResult, { kind: "fenced" }>,
		actionToken: HandoffRecoveryIntentActionToken,
	): Promise<void> {
		if (!this.isIntentActionCurrent(actionToken)) return;
		const retained = put.retainedRecord;
		if (retained && !isActiveHandoffRecoveryRecord(retained)) {
			this.deliverTerminal(request, retained, actionToken);
			return;
		}
		if (retained && put.action === "discard") {
			const finalized = await this.store.resolveRecord({
				kind: "finalize-active",
				recordId: retained.recordId,
				expectedChecksum: retained.checksum,
				disposition: "discard",
				finalizedAt: this.now(),
			});
			if (!this.isIntentActionCurrent(actionToken)) return;
			if (
				(finalized.kind !== "updated" && finalized.kind !== "unchanged")
				|| isActiveHandoffRecoveryRecord(finalized.record)
			) {
				throw new Error("Acknowledged Recovery discard did not finalize");
			}
			this.deliverTerminal(request, finalized.record, actionToken);
			return;
		}
		if (retained) {
			const manual = retained.status === "needs-review"
				? retained
				: await this.requireNeedsReview(
					retained.recordId,
					await this.store.compareAndSetStatus(
						retained.recordId,
						retained.checksum,
						{ from: retained.status, to: "needs-review" },
					),
				);
			if (!this.isIntentActionCurrent(actionToken)) return;
			this.deliver(request, {
				kind: "needs-review",
				intentId: manual.intentId,
				recordId: manual.recordId,
			}, actionToken);
			return;
		}
		this.deliver(request, put.action === "discard"
			? {
				kind: "discarded",
				intentId: request.intent.intentId,
				recordId: null,
			}
			: {
				kind: "escaped",
				intentId: request.intent.intentId,
				action: put.action,
				recordId: null,
			}, actionToken);
	}

	private async finishExplicitEscape(
		request: HandoffRecoveryRuntimeRequest,
		action: "copy" | "export" | "discard",
		outcome: ResolveHandoffRecoveryResult,
		actionToken: HandoffRecoveryIntentActionToken,
	): Promise<void> {
		if (!this.isIntentActionCurrent(actionToken)) return;
		if (outcome.kind === "retained") {
			await this.finishFencedPut(request, {
				kind: "fenced",
				action,
				retainedRecord: outcome.record,
			}, actionToken);
			return;
		}
		if (outcome.kind !== "escaped") {
			throw new Error(`Unexpected precommit escape result: ${outcome.kind}`);
		}
		this.deliver(request, action === "discard"
			? {
				kind: "discarded",
				intentId: request.intent.intentId,
				recordId: null,
			}
			: {
				kind: "escaped",
				intentId: request.intent.intentId,
				action,
				recordId: null,
			}, actionToken);
	}

	private deliverTerminal(
		request: HandoffRecoveryRuntimeRequest,
		record: TerminalHandoffRecoveryReceipt,
		actionToken: HandoffRecoveryIntentActionToken,
	): void {
		this.deliver(request, record.status === "resolved"
			? {
				kind: "resolved",
				intentId: record.intentId,
				recordId: record.recordId,
			}
			: {
				kind: "discarded",
				intentId: record.intentId,
				recordId: record.recordId,
			}, actionToken);
	}
}

function classifyRecoveryFailure(error: unknown): string {
	const name = error instanceof DOMException ? error.name : "";
	if (name === "QuotaExceededError") return "quota-exceeded";
	if (name === "UnknownError") return "indexeddb-operational-error";
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	if (message.includes("blocked")) return "indexeddb-blocked";
	if (message.includes("unavailable")) return "indexeddb-unavailable";
	if (message.includes("verification") || message.includes("checksum")) {
		return "verification-failed";
	}
	return "write-failed";
}
