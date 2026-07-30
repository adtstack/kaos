import type {
	HandoffReplayManualReason,
	HandoffReplayReplanReason,
} from "../sync/editorHandoffReplay";

export type HandoffReplayClassificationQaReason =
	| "claimed-awaiting-presentation"
	| "claimed-binding-requested"
	| "scope-stale-at-entry"
	| "request-session-mismatch"
	| "request-generation-mismatch"
	| "record-intent-mismatch"
	| "event-proof-session-mismatch"
	| "event-proof-generation-mismatch"
	| "record-validation-failed"
	| "record-validation-replaced"
	| "record-validation-status-changed"
	| "composition-proof-unavailable"
	| `verify-manual:${HandoffReplayManualReason}`
	| `verify-replan:${HandoffReplayReplanReason}`
	| "scope-stale-after-verification"
	| "binding-request-rejected"
	| "binding-request-context-stale"
	| "claim-stale-after-binding-request";

/** QA-only, content-free receipt for the stored-intent classifier boundary. */
export type HandoffReplayClassificationQaObservation = Readonly<{
	sequence: number;
	outcome: "claimed" | "manual";
	reason: HandoffReplayClassificationQaReason;
	recordId: string;
	intentId: string;
	sessionId: string;
	expectedGeneration: number;
}>;

type ClassificationInput = Omit<
	HandoffReplayClassificationQaObservation,
	"sequence"
>;

type ObserverState = {
	sequence: number;
	readonly observe: (observation: HandoffReplayClassificationQaObservation) => void;
};

const observers = new WeakMap<object, ObserverState>();

export function associateHandoffReplayClassificationObserverForQa(
	owner: object,
	observe: (observation: HandoffReplayClassificationQaObservation) => void,
): void {
	observers.set(owner, { sequence: 0, observe });
}

export function observeHandoffReplayClassificationForQa(
	owner: object,
	input: ClassificationInput,
): void {
	const state = observers.get(owner);
	if (!state) return;
	const observation = Object.freeze({
		sequence: ++state.sequence,
		...input,
	});
	try {
		state.observe(observation);
	} catch {
		// QA diagnostics are observation-only and cannot affect replay authority.
	}
}
