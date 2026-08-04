import {
	canonicalHandoffRecoveryJson,
	isActiveHandoffRecoveryRecord,
	validateHandoffRecoveryRecord,
	type ActiveHandoffRecoveryRecord,
	type ClearHandoffRecoveryScopeResult,
	type HandoffRecoveryCasResult,
	type HandoffRecoveryHydrationResult,
	type HandoffRecoveryRecord,
	type HandoffRecoveryStore,
	type TerminalHandoffRecoveryReceipt,
} from "../sync/handoffRecoveryStore";
import type { DashboardHandoffRecovery } from "../dashboard/dashboardTypes";

export interface HandoffRecoveryCoordinatorDeps {
	store: HandoffRecoveryStore;
	now?: () => number;
	isScopeCurrent(): boolean;
}

type HydratedRecordConvergence =
	| { kind: "active"; record: ActiveHandoffRecoveryRecord }
	| { kind: "terminal"; record: TerminalHandoffRecoveryReceipt }
	| { kind: "failed"; reason: "missing" | "corrupt" | "scope-stale" };

export class ManualHandoffRecoveryCoordinator {
	private readonly store: HandoffRecoveryStore;
	private readonly now: () => number;
	private readonly isScopeCurrent: () => boolean;
	private actionEpoch = 0;

	constructor(deps: HandoffRecoveryCoordinatorDeps) {
		this.store = deps.store;
		this.now = deps.now ?? (() => Date.now());
		this.isScopeCurrent = () => deps.isScopeCurrent();
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
					status: "needs-review";
				}> => record.status === "needs-review")
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
		await this.drain();
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
}
