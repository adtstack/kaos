/**
 * Hooks for one destructive pending-blob intent attempt.
 *
 * The caller owns the journal fields and exact scope checks. This coordinator
 * owns only the ordering invariant: a durable attempted fence must exist before
 * the CRDT CAS, and the post-CAS state must never be returned to ready merely
 * because receipt or phase-two persistence failed.
 */
export interface PendingBlobIntentCommitHooks<Result> {
	markAttempted(): boolean;
	persistAttempted(): Promise<void>;
	isAttemptCurrent(): boolean;
	apply(): Result;
	isApplyCurrent(result: Result): boolean;
	isKnownNoMutation(result: Result): boolean;
	clearAttempt(): boolean;
	markCommitted(result: Result): boolean;
	persistFinal(): Promise<void>;
	flushReceipt(): Promise<void>;
}

export type PendingBlobIntentCommitOutcome<Result> =
	| { kind: "not-started" }
	| { kind: "attempt-persist-failed"; error: unknown }
	| { kind: "stale-after-attempt" }
	| {
		kind: "ambiguous";
		stage: "precondition" | "apply" | "postcondition" | "clear-attempt" | "mark-committed";
		error?: unknown;
		result?: Result;
	}
	| { kind: "known-no-mutation"; result: Result }
	| { kind: "clear-persist-failed"; result: Result; error: unknown }
	| {
		kind: "committed";
		result: Result;
		receiptError?: unknown;
	}
	| {
		kind: "commit-persist-failed";
		result: Result;
		error: unknown;
		receiptError?: unknown;
	};

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Execute one pending attachment mutation with a durable pre-CAS fence.
 *
 * `persistFinal()` is started synchronously after the in-memory transition so
 * it captures the same authority scope before either awaited operation can
 * resume on a different host/vault. Receipt and phase-two persistence may run
 * concurrently: either durable attempted or durable committed state is safe
 * after a crash, while a ready state is allowed only for a proven no-mutation
 * result whose clear was itself persisted.
 */
export async function commitPendingBlobIntentWithWriteAhead<Result>(
	hooks: PendingBlobIntentCommitHooks<Result>,
): Promise<PendingBlobIntentCommitOutcome<Result>> {
	if (!hooks.markAttempted()) return { kind: "not-started" };

	try {
		await hooks.persistAttempted();
	} catch (error) {
		return { kind: "attempt-persist-failed", error };
	}

	try {
		if (!hooks.isAttemptCurrent()) return { kind: "stale-after-attempt" };
	} catch (error) {
		return { kind: "ambiguous", stage: "precondition", error };
	}

	let result: Result;
	try {
		result = hooks.apply();
	} catch (error) {
		return { kind: "ambiguous", stage: "apply", error };
	}
	try {
		if (!hooks.isApplyCurrent(result)) {
			return { kind: "ambiguous", stage: "postcondition", result };
		}
	} catch (error) {
		return { kind: "ambiguous", stage: "postcondition", error, result };
	}

	if (hooks.isKnownNoMutation(result)) {
		if (!hooks.clearAttempt()) {
			return { kind: "ambiguous", stage: "clear-attempt", result };
		}
		try {
			await hooks.persistFinal();
			return { kind: "known-no-mutation", result };
		} catch (error) {
			return { kind: "clear-persist-failed", result, error };
		}
	}

	if (!hooks.markCommitted(result)) {
		return { kind: "ambiguous", stage: "mark-committed", result };
	}

	let finalPersistence: Promise<void>;
	try {
		finalPersistence = hooks.persistFinal();
	} catch (error) {
		finalPersistence = Promise.reject(asError(error));
	}
	let receiptPersistence: Promise<void>;
	try {
		receiptPersistence = hooks.flushReceipt();
	} catch (error) {
		receiptPersistence = Promise.reject(asError(error));
	}
	const [finalResult, receiptResult] = await Promise.allSettled([
		finalPersistence,
		receiptPersistence,
	]);
	const receiptError = receiptResult.status === "rejected"
		? receiptResult.reason as unknown
		: undefined;
	if (finalResult.status === "rejected") {
		return {
			kind: "commit-persist-failed",
			result,
			error: finalResult.reason as unknown,
			...(receiptError !== undefined && { receiptError }),
		};
	}
	return {
		kind: "committed",
		result,
		...(receiptError !== undefined && { receiptError }),
	};
}
