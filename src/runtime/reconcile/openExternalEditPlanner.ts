import { mergeTexts3 } from "../../utils/threeWayMerge";

export interface OpenExternalEditPlanInput {
	baselineText: string | null;
	currentText: string;
	externalText: string;
}

export type OpenExternalEditPlan =
	| { kind: "already-settled"; targetText: string }
	| { kind: "apply-external"; targetText: string }
	| { kind: "keep-current"; targetText: string }
	| { kind: "apply-clean-merge"; targetText: string }
	| {
		kind: "preserve-conflict";
		reason: "missing-baseline" | "overlapping-hunks";
		hunkCount: number;
	};

export function planOpenExternalEdit(
	input: OpenExternalEditPlanInput,
): OpenExternalEditPlan {
	const { baselineText, currentText, externalText } = input;
	if (currentText === externalText) {
		return { kind: "already-settled", targetText: currentText };
	}
	if (baselineText === null) {
		return {
			kind: "preserve-conflict",
			reason: "missing-baseline",
			hunkCount: 0,
		};
	}

	const result = mergeTexts3(baselineText, currentText, externalText);
	if (result.kind === "conflict") {
		return {
			kind: "preserve-conflict",
			reason: "overlapping-hunks",
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
	if (result.mergedText === externalText) {
		return { kind: "apply-external", targetText: externalText };
	}
	if (result.mergedText === currentText) {
		return { kind: "keep-current", targetText: currentText };
	}
	return { kind: "apply-clean-merge", targetText: result.mergedText };
}
