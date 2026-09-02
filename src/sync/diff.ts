/**
 * Character-level diff utility for applying external text changes to a Y.Text
 * as targeted inserts/deletes rather than a wholesale replace.
 *
 * This preserves CRDT history and cursor positions when an external tool
 * (git, another editor) modifies a file that's currently open.
 */
import diff from "fast-diff";
import * as Y from "yjs";

/**
 * Diff operation: retain N chars, delete N chars, or insert a string.
 */
type DiffOp =
	| { type: "retain"; count: number }
	| { type: "delete"; count: number }
	| { type: "insert"; text: string };

/**
 * Compute a character diff between `oldText` and `newText`, then
 * apply it to the Y.Text as a series of targeted operations.
 *
 * Uses `fast-diff`, a compact Myers-style diff implementation.
 */
export function applyDiffToYText(
	ytext: Y.Text,
	oldText: string,
	newText: string,
	origin: string | object,
): void {
	if (oldText === newText) return;

	// `fast-diff` gives us a synchronous Myers-style patch without building
	// the old quadratic DP matrix that used to freeze on large notes.
	const charOps = diffToCharOps(diff(oldText, newText));
	if (charOps.length === 0) return;

	// Apply to Y.Text in a single transaction so collaborators see one patch.
	ytext.doc?.transact(() => {
		let cursor = 0;
		for (const op of charOps) {
			switch (op.type) {
				case "retain":
					cursor += op.count;
					break;
				case "delete":
					ytext.delete(cursor, op.count);
					break;
				case "insert":
					ytext.insert(cursor, op.text);
					cursor += op.text.length;
					break;
			}
		}
	}, origin);
}

export type ExactDiffResult =
	| { kind: "unchanged" }
	| { kind: "applied" }
	| { kind: "stale-base"; currentText: string }
	| { kind: "postcondition-failed"; currentText: string };

export function applyExactDiffToYText(
	ytext: Y.Text,
	expectedOldText: string,
	newText: string,
	origin: string,
): ExactDiffResult {
	const currentText = ytext.toJSON();
	if (currentText !== expectedOldText) {
		return { kind: "stale-base", currentText };
	}
	if (currentText === newText) return { kind: "unchanged" };
	applyDiffToYText(ytext, expectedOldText, newText, origin);
	const after = ytext.toJSON();
	return after === newText
		? { kind: "applied" }
		: { kind: "postcondition-failed", currentText: after };
}

export interface DiffPostconditionResult {
	diffSkippedDueToStaleBase: boolean;
	matchesAfterDiff: boolean;
	forceReplaceApplied: boolean;
	finalMatchesExpected: boolean;
	finalLength: number;
}

/**
 * A replacement hunk discovered by diffing a variant against the base:
 * baseText[baseStart..baseEnd) is replaced by `text` (empty text = pure
 * deletion, baseStart === baseEnd = pure insertion).
 */
interface BaseReplacement {
	baseStart: number;
	baseEnd: number;
	text: string;
}

export interface ConcurrentEditsMergeResult {
	/** Merged text carrying both sides' non-overlapping changes. */
	mergedText: string;
	/**
	 * True when the two sides changed overlapping base regions and the
	 * concurrent side (currentText) won the overlap by preference.
	 */
	hadConflictingOverlap: boolean;
}

function diffBaseReplacements(
	baseText: string,
	variantText: string,
): BaseReplacement[] {
	const replacements: BaseReplacement[] = [];
	let basePos = 0;
	let start = -1;
	let end = -1;
	let text = "";
	const flush = () => {
		if (start !== -1) {
			replacements.push({ baseStart: start, baseEnd: end, text });
		}
		start = -1;
		end = -1;
		text = "";
	};
	for (const [op, segText] of diff(baseText, variantText)) {
		if (op === 0) {
			flush();
			basePos += segText.length;
		} else if (op === 1) {
			if (start === -1) {
				start = basePos;
				end = basePos;
			}
			text += segText;
		} else {
			if (start === -1) {
				start = basePos;
				end = basePos;
			}
			end = basePos + segText.length;
			basePos = end;
		}
	}
	flush();
	return replacements;
}

/**
 * Three-way merge at character granularity: baseText evolved concurrently into
 * `currentText` (e.g. live editor typing that happened after a caller captured
 * its base) and into `targetText` (the caller's authority decision). Both
 * sides' changes are preserved whenever they touch disjoint base regions.
 * Overlapping changes are resolved in favor of `currentText` — the newer,
 * concurrent edits must never be silently discarded — and the conflict is
 * reported so callers can re-plan instead of assuming the target landed.
 */
export function mergeConcurrentEdits(
	baseText: string,
	currentText: string,
	targetText: string,
): ConcurrentEditsMergeResult {
	const ours = diffBaseReplacements(baseText, currentText);
	const theirs = diffBaseReplacements(baseText, targetText);
	let hadConflictingOverlap = false;

	// Suppress every target hunk that overlaps a concurrent hunk (or exactly
	// duplicates it) so the sequential apply below never has to drop live edits.
	const suppressedTheirs = new Set<number>();
	for (let k = 0; k < theirs.length; k++) {
		const t = theirs[k]!;
		let suppress = false;
		for (const o of ours) {
			const identical =
				o.baseStart === t.baseStart &&
				o.baseEnd === t.baseEnd &&
				o.text === t.text;
			if (identical) {
				suppress = true;
				break;
			}
			const overlaps =
				t.baseStart < o.baseEnd && o.baseStart < t.baseEnd;
			if (overlaps) {
				suppress = true;
				hadConflictingOverlap = true;
				break;
			}
		}
		if (suppress) suppressedTheirs.add(k);
	}

	const applied: BaseReplacement[] = [
		...ours,
		...theirs.filter((_, k) => !suppressedTheirs.has(k)),
	].sort(
		(a, b) =>
			a.baseStart - b.baseStart ||
			a.baseEnd - b.baseEnd ||
			(a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
	);

	let out = "";
	let cursor = 0;
	for (const hunk of applied) {
		if (hunk.baseStart < cursor) continue;
		out += baseText.slice(cursor, hunk.baseStart) + hunk.text;
		cursor = Math.max(cursor, hunk.baseEnd);
	}
	out += baseText.slice(cursor);
	return { mergedText: out, hadConflictingOverlap };
}

export function applyDiffToYTextWithPostcondition(
	ytext: Y.Text,
	oldText: string,
	newText: string,
	origin: string,
): DiffPostconditionResult {
	const currentText = ytext.toJSON();
	if (currentText !== oldText) {
		// The caller's base became stale before commit: the Y.Text concurrently
		// evolved (typically live editor typing while an async recovery lane was
		// in flight). Replaying a patch computed from newText alone would delete
		// everything typed in the gap — the "text merges together and
		// disappears" failure mode. Merge the caller's intended oldText→newText
		// change with the concurrent oldText→currentText change instead, and
		// keep the merged result even when it no longer equals newText: callers
		// observe finalMatchesExpected=false and re-plan with a fresh capture.
		const concurrent = mergeConcurrentEdits(oldText, currentText, newText);
		applyDiffToYText(ytext, currentText, concurrent.mergedText, origin);
		const afterMergedDiff = ytext.toJSON();
		if (afterMergedDiff === newText) {
			return {
				diffSkippedDueToStaleBase: true,
				matchesAfterDiff: true,
				forceReplaceApplied: false,
				finalMatchesExpected: true,
				finalLength: afterMergedDiff.length,
			};
		}
		if (afterMergedDiff !== concurrent.mergedText) {
			// The merge diff itself failed to land (should be unreachable: the
			// base was read synchronously). Fall back to the explicit merge
			// result rather than to newText, which lacks the concurrent edits.
			forceReplaceYText(ytext, concurrent.mergedText, origin);
			const afterForce = ytext.toJSON();
			return {
				diffSkippedDueToStaleBase: true,
				matchesAfterDiff: false,
				forceReplaceApplied: true,
				finalMatchesExpected: afterForce === newText,
				finalLength: afterForce.length,
			};
		}
		return {
			diffSkippedDueToStaleBase: true,
			matchesAfterDiff: false,
			forceReplaceApplied: false,
			finalMatchesExpected: false,
			finalLength: afterMergedDiff.length,
		};
	}

	applyDiffToYText(ytext, oldText, newText, origin);

	const afterDiff = ytext.toJSON();
	if (afterDiff === newText) {
		return {
			diffSkippedDueToStaleBase: false,
			matchesAfterDiff: true,
			forceReplaceApplied: false,
			finalMatchesExpected: true,
			finalLength: afterDiff.length,
		};
	}

	forceReplaceYText(ytext, newText, origin);
	const afterForce = ytext.toJSON();
	return {
		diffSkippedDueToStaleBase: false,
		matchesAfterDiff: false,
		forceReplaceApplied: true,
		finalMatchesExpected: afterForce === newText,
		finalLength: afterForce.length,
	};
}

export function forceReplaceYText(
	ytext: Y.Text,
	newText: string,
	origin: string,
): void {
	// Recovery-only. Do not use for normal sync/edit propagation.
	// Callers must already have chosen newText as the authority. This fallback
	// intentionally discards current Y.Text content when a targeted recovery
	// diff cannot satisfy its postcondition.
	const replace = () => {
		const currentLength = ytext.length;
		if (currentLength > 0) ytext.delete(0, currentLength);
		if (newText.length > 0) ytext.insert(0, newText);
	};
	if (ytext.doc) {
		ytext.doc.transact(replace, origin);
	} else {
		replace();
	}
}

function diffToCharOps(segments: Array<[-1 | 0 | 1, string]>): DiffOp[] {
	const ops: DiffOp[] = [];

	for (const [kind, text] of segments) {
		if (text.length === 0) continue;

		switch (kind) {
			case 0:
				pushRetain(ops, text.length);
				break;
			case -1:
				pushDelete(ops, text.length);
				break;
			case 1:
				pushInsert(ops, text);
				break;
		}
	}

	return ops;
}

function pushRetain(ops: DiffOp[], count: number): void {
	if (count <= 0) return;
	const last = ops[ops.length - 1];
	if (last?.type === "retain") {
		last.count += count;
		return;
	}
	ops.push({ type: "retain", count });
}

function pushDelete(ops: DiffOp[], count: number): void {
	if (count <= 0) return;
	const last = ops[ops.length - 1];
	if (last?.type === "delete") {
		last.count += count;
		return;
	}
	ops.push({ type: "delete", count });
}

function pushInsert(ops: DiffOp[], text: string): void {
	if (text.length === 0) return;
	const last = ops[ops.length - 1];
	if (last?.type === "insert") {
		last.text += text;
		return;
	}
	ops.push({ type: "insert", text });
}
