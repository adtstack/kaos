import type { PendingBlobIntent } from "./pendingBlobIntentJournal";

/**
 * Observed world state for the source path of one pending blob intent.
 * Ground truth is re-read at every replay pass; it is never cached.
 */
export interface PendingBlobIntentGroundTruth {
	/** Any vault entry (typically a recreated file) occupies the source path. */
	diskOccupied: boolean;
	/** The CRDT currently holds a live (non-tombstoned) blob ref for the path. */
	liveRef: boolean;
}

export type PendingBlobIntentRetirementDisposition =
	| { kind: "retain" }
	/**
	 * The intent's target state — absence — is already the settled CRDT and
	 * disk truth. The journal entry protects nothing and only re-arms its
	 * quarantine every replay pass.
	 */
	| { kind: "retire-absence-settled" }
	/**
	 * A live CRDT ref owns the path while the disk file is gone: the local
	 * mutation lost to a later remote authority. The caller must hand the
	 * path off to the legacy-missing-blob attention so downloads stay gated
	 * and the operator gets the standard download-or-keep-absence choice.
	 */
	| { kind: "retire-authority-moved" }
	/**
	 * A durable commit attempt observed outside its own write-ahead run is a
	 * dead attempt (the replay chain serializes passes, so no live attempt can
	 * be visible here). A recreated occupant must not stay fenced by it.
	 */
	| { kind: "retire-stale-local-episode" }
	/**
	 * The operator explicitly dismissed the episode from the dashboard. Never
	 * produced by the automatic replay decision; constructed by the dismiss
	 * action after its own ground-truth check for the handoff case.
	 */
	| { kind: "retire-operator-dismissed" };

/**
 * Decide whether a pending blob intent that the replay loop has already
 * quarantined may be retired instead of re-recorded.
 *
 * This decision only runs at replay sites that would otherwise record a
 * committed-intent conflict. Intents still on a normal path — ready, awaiting
 * CAS, or committed with a satisfiable postcondition — never reach it, so
 * ordinary receipt waiting cannot be retired by accident.
 */
export function decidePendingBlobIntentRetirement(
	intent: Pick<PendingBlobIntent, "commitAttemptId">,
	groundTruth: PendingBlobIntentGroundTruth,
): PendingBlobIntentRetirementDisposition {
	if (!groundTruth.diskOccupied) {
		return groundTruth.liveRef
			? { kind: "retire-authority-moved" }
			: { kind: "retire-absence-settled" };
	}
	if (intent.commitAttemptId !== undefined) {
		return { kind: "retire-stale-local-episode" };
	}
	return { kind: "retain" };
}
