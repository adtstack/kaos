import type { QaExternalPhaseTicket } from "./types";

type WaitingPhase = {
	readonly ticket: QaExternalPhaseTicket;
	readonly resolve: (ticket: QaExternalPhaseTicket) => void;
	readonly reject: (reason: Error) => void;
	readonly onAbort: () => void;
};

export interface EditorHandoffExternalPhaseCoordinator {
	awaitExternalPhase<Name extends string>(name: Name): Promise<QaExternalPhaseTicket<Name>>;
	getExternalPhaseTicket(): QaExternalPhaseTicket | null;
	resumeExternalPhase(runId: string, sequence: number): boolean;
	rejectCurrent(reason: Error): void;
	dispose(reason?: Error): void;
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error(typeof signal.reason === "string" ? signal.reason : "QA run aborted");
}

export function createEditorHandoffExternalPhaseCoordinator(input: Readonly<{
	runId: string;
	scenarioId: string;
	signal: AbortSignal;
}>): EditorHandoffExternalPhaseCoordinator {
	let sequence = 0;
	let waiting: WaitingPhase | null = null;
	let disposed = false;

	const clearWaiting = (entry: WaitingPhase): void => {
		if (waiting !== entry) return;
		input.signal.removeEventListener("abort", entry.onAbort);
		waiting = null;
	};

	const rejectWaiting = (reason: Error): void => {
		const entry = waiting;
		if (!entry) return;
		clearWaiting(entry);
		entry.reject(reason);
	};

	return {
		awaitExternalPhase<Name extends string>(
			name: Name,
		): Promise<QaExternalPhaseTicket<Name>> {
			if (disposed) return Promise.reject(new Error("external phase coordinator disposed"));
			if (input.signal.aborted) return Promise.reject(abortReason(input.signal));
			if (waiting) return Promise.reject(new Error("external phase already waiting"));
			const ticket: QaExternalPhaseTicket<Name> = Object.freeze({
				runId: input.runId,
				sequence: ++sequence,
				scenarioId: input.scenarioId,
				name,
				state: "waiting",
			});
			return new Promise<QaExternalPhaseTicket<Name>>((resolve, reject) => {
				const onAbort = (): void => rejectWaiting(abortReason(input.signal));
				const entry: WaitingPhase = {
					ticket,
					resolve: resolve as (value: QaExternalPhaseTicket) => void,
					reject,
					onAbort,
				};
				waiting = entry;
				input.signal.addEventListener("abort", onAbort, { once: true });
			});
		},

		getExternalPhaseTicket(): QaExternalPhaseTicket | null {
			return waiting?.ticket ?? null;
		},

		resumeExternalPhase(runId: string, resumedSequence: number): boolean {
			const entry = waiting;
			if (
				!entry
				|| entry.ticket.runId !== runId
				|| entry.ticket.sequence !== resumedSequence
			) return false;
			clearWaiting(entry);
			entry.resolve(Object.freeze({ ...entry.ticket, state: "resumed" }));
			return true;
		},

		rejectCurrent(reason: Error): void {
			rejectWaiting(reason);
		},

		dispose(reason = new Error("external phase coordinator disposed")): void {
			if (disposed) return;
			disposed = true;
			rejectWaiting(reason);
		},
	};
}
