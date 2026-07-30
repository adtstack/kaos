import { ChangeSet } from "@codemirror/state";
import diff from "fast-diff";
import { mergeTexts3 } from "../../utils/threeWayMerge";

export interface SamePathAdoptionPlanInput {
	baselineText: string | null;
	localText: string;
	remoteText: string;
}

export type SamePathAdoptionPlan =
	| { kind: "already-settled"; targetText: string }
	| { kind: "apply-local"; targetText: string }
	| { kind: "apply-remote"; targetText: string }
	| { kind: "apply-clean-merge"; targetText: string }
	| {
		kind: "preserve-conflict";
		reason: "missing-baseline" | "conflicting-hunks";
		hunkCount: number;
	};

export function planSamePathAdoption(
	input: SamePathAdoptionPlanInput,
): SamePathAdoptionPlan {
	const { baselineText, localText, remoteText } = input;
	if (localText === remoteText) {
		return { kind: "already-settled", targetText: localText };
	}
	if (baselineText === null) {
		return {
			kind: "preserve-conflict",
			reason: "missing-baseline",
			hunkCount: 0,
		};
	}

	const result = mergeTexts3(baselineText, localText, remoteText);
	if (result.kind === "conflict") {
		return {
			kind: "preserve-conflict",
			reason: "conflicting-hunks",
			hunkCount: result.hunks.length,
		};
	}
	if (result.kind === "no-base") {
		return {
			kind: "preserve-conflict",
			reason: "missing-baseline",
			hunkCount: 0,
		};
	}
	if (result.mergedText === localText) {
		return { kind: "apply-local", targetText: localText };
	}
	if (result.mergedText === remoteText) {
		return { kind: "apply-remote", targetText: remoteText };
	}
	return { kind: "apply-clean-merge", targetText: result.mergedText };
}

export function buildSamePathAdoptionChangeSet(
	fromText: string,
	toText: string,
): ChangeSet {
	if (fromText === toText) return ChangeSet.empty(fromText.length);

	const specs: Array<{ from: number; to: number; insert: string }> = [];
	let fromCursor = 0;
	let pending: { from: number; to: number; insert: string } | null = null;
	const flush = (): void => {
		if (pending === null) return;
		specs.push(pending);
		pending = null;
	};

	for (const [kind, text] of diff(fromText, toText)) {
		if (kind === 0) {
			flush();
			fromCursor += text.length;
			continue;
		}
		if (pending === null) {
			pending = { from: fromCursor, to: fromCursor, insert: "" };
		}
		if (kind === -1) {
			fromCursor += text.length;
			pending.to = fromCursor;
		} else {
			pending.insert += text;
		}
	}
	flush();
	return ChangeSet.of(specs, fromText.length);
}
