import diff from "fast-diff";

const LINE_TOKEN_BASE = 0xe000;
const MAX_LINE_TOKENS = 0xf8ff - LINE_TOKEN_BASE + 1;

export interface ThreeWayMergeConflictHunk {
	index: number;
	baseStart: number;
	baseEnd: number;
	baseText: string;
	leftText: string;
	rightText: string;
}

export type ThreeWayMergeSegment =
	| { kind: "text"; text: string }
	| { kind: "conflict"; hunkIndex: number };

export type ThreeWayMergeResult =
	| { kind: "no-base" }
	| { kind: "clean-merge"; mergedText: string }
	| {
		kind: "conflict";
		partialMergedText: string;
		hunks: ThreeWayMergeConflictHunk[];
		segments: ThreeWayMergeSegment[];
	};

interface LineChange {
	baseStart: number;
	baseEnd: number;
	lines: string[];
}

interface BaseRange {
	start: number;
	end: number;
}

interface EncodedLines {
	base: string;
	variant: string;
	lines: string[];
}

export function mergeTexts3(
	baseText: string | null | undefined,
	leftText: string,
	rightText: string,
): ThreeWayMergeResult {
	if (baseText === null || baseText === undefined) return { kind: "no-base" };
	if (leftText === rightText) return { kind: "clean-merge", mergedText: leftText };
	if (baseText === leftText) return { kind: "clean-merge", mergedText: rightText };
	if (baseText === rightText) return { kind: "clean-merge", mergedText: leftText };

	const baseLines = splitLineTokens(baseText);
	const leftLines = splitLineTokens(leftText);
	const rightLines = splitLineTokens(rightText);
	const leftChanges = buildLineChanges(baseLines, leftLines);
	const rightChanges = buildLineChanges(baseLines, rightLines);

	const conflictRanges = mergeBaseRanges([
		...collectConflictRanges(leftChanges, rightChanges),
		...collectAmbiguousSharedRemovalReintroductionRanges(
			baseLines,
			leftChanges,
			rightChanges,
		),
		...collectAmbiguousRepeatedLineAlignmentRanges(
			baseLines,
			leftChanges,
			rightChanges,
		),
	]);
	if (conflictRanges.length === 0) {
		return {
			kind: "clean-merge",
			mergedText: applyNonConflictingChanges(baseLines, leftChanges, rightChanges),
		};
	}

	return buildConflictResult(baseLines, leftChanges, rightChanges, conflictRanges);
}

function splitLineTokens(text: string): string[] {
	if (text.length === 0) return [];
	return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function buildLineChanges(baseLines: string[], variantLines: string[]): LineChange[] {
	const encoded = encodeLineTokens(baseLines, variantLines);
	if (!encoded) {
		return [{ baseStart: 0, baseEnd: baseLines.length, lines: variantLines }];
	}

	const changes: LineChange[] = [];
	let current: LineChange | null = null;
	let baseCursor = 0;

	const ensureCurrent = (): LineChange => {
		if (current) return current;
		current = { baseStart: baseCursor, baseEnd: baseCursor, lines: [] };
		return current;
	};
	const flushCurrent = () => {
		if (!current) return;
		changes.push(current);
		current = null;
	};

	for (const [kind, tokenText] of diff(encoded.base, encoded.variant, undefined, false)) {
		const lines = decodeTokenText(encoded.lines, tokenText);
		if (kind === 0) {
			flushCurrent();
			baseCursor += lines.length;
			continue;
		}
		const change = ensureCurrent();
		if (kind === -1) {
			baseCursor += lines.length;
			change.baseEnd = baseCursor;
		} else {
			change.lines.push(...lines);
		}
	}
	flushCurrent();
	return changes;
}

function encodeLineTokens(baseLines: string[], variantLines: string[]): EncodedLines | null {
	const tokenByLine = new Map<string, string>();
	const lines: string[] = [];

	const tokenForLine = (line: string): string | null => {
		const existing = tokenByLine.get(line);
		if (existing) return existing;
		if (lines.length >= MAX_LINE_TOKENS) return null;
		const token = String.fromCharCode(LINE_TOKEN_BASE + lines.length);
		tokenByLine.set(line, token);
		lines.push(line);
		return token;
	};

	const encode = (source: string[]): string | null => {
		let encoded = "";
		for (const line of source) {
			const token = tokenForLine(line);
			if (token === null) return null;
			encoded += token;
		}
		return encoded;
	};

	const base = encode(baseLines);
	if (base === null) return null;
	const variant = encode(variantLines);
	if (variant === null) return null;
	return { base, variant, lines };
}

function decodeTokenText(lines: string[], tokenText: string): string[] {
	const output: string[] = [];
	for (const token of tokenText) {
		output.push(lines[token.charCodeAt(0) - LINE_TOKEN_BASE] ?? "");
	}
	return output;
}

function collectConflictRanges(
	leftChanges: LineChange[],
	rightChanges: LineChange[],
): BaseRange[] {
	const ranges: BaseRange[] = [];
	for (const left of leftChanges) {
		for (const right of rightChanges) {
			// The same delta can be applied once. Distinct replacements at the same
			// base range remain a conflict even when one happens to contain all lines
			// from the other: containment does not prove that an omitted line was not
			// intentionally deleted.
			if (lineChangesEqual(left, right)) continue;
			if (!rangesTouch(left, right)) continue;
			ranges.push({
				start: Math.min(left.baseStart, right.baseStart),
				end: Math.max(left.baseEnd, right.baseEnd),
			});
		}
	}
	return mergeBaseRanges(ranges);
}

function lineChangesEqual(left: LineChange, right: LineChange): boolean {
	return left.baseStart === right.baseStart &&
		left.baseEnd === right.baseEnd &&
		left.lines.length === right.lines.length &&
		left.lines.every((line, index) => line === right.lines[index]);
}

function containsLineSubsequence(container: string[], candidate: string[]): boolean {
	if (candidate.length === 0) return true;
	let candidateIndex = 0;
	for (const line of container) {
		if (line !== candidate[candidateIndex]) continue;
		candidateIndex++;
		if (candidateIndex === candidate.length) return true;
	}
	return false;
}

/**
 * A move can look like one exact shared removal plus a non-overlapping insertion
 * on only one side. Treating those deltas as independent would silently revive
 * text that the other side intentionally removed. Conflict only when a
 * unilateral change reintroduces an exact line removed by the shared change;
 * unrelated insertions remain mergeable.
 */
function collectAmbiguousSharedRemovalReintroductionRanges(
	baseLines: string[],
	leftChanges: LineChange[],
	rightChanges: LineChange[],
): BaseRange[] {
	const ranges: BaseRange[] = [];
	const sharedChanges = leftChanges.filter((left) =>
		rightChanges.some((right) => lineChangesEqual(left, right)));
	const sharedRemovals = sharedChanges.filter((change) =>
		change.baseStart < change.baseEnd);
	const commonCounts = countLinesAfterChanges(baseLines, sharedChanges);
	const leftCounts = countLinesAfterChanges(baseLines, leftChanges);
	const rightCounts = countLinesAfterChanges(baseLines, rightChanges);

	for (const shared of sharedRemovals) {
		const retainedCounts = new Map<string, number>();
		for (const line of shared.lines) {
			retainedCounts.set(line, (retainedCounts.get(line) ?? 0) + 1);
		}
		const removedLines = new Set<string>();
		for (const line of baseLines.slice(shared.baseStart, shared.baseEnd)) {
			const retained = retainedCounts.get(line) ?? 0;
			if (retained > 0) {
				retainedCounts.set(line, retained - 1);
			} else {
				removedLines.add(line);
			}
		}
		if (removedLines.size === 0) continue;

		const collectUnilateralReintroductions = (
			changes: LineChange[],
			otherChanges: LineChange[],
			sideCounts: Map<string, number>,
		) => {
			for (const candidate of changes) {
				if (lineChangesEqual(candidate, shared)) continue;
				if (otherChanges.some((other) => lineChangesEqual(candidate, other))) continue;
				if (!candidate.lines.some((line) =>
					removedLines.has(line) &&
					(sideCounts.get(line) ?? 0) > (commonCounts.get(line) ?? 0))) continue;
				ranges.push({
					start: Math.min(shared.baseStart, candidate.baseStart),
					end: Math.max(shared.baseEnd, candidate.baseEnd),
				});
			}
		};

		collectUnilateralReintroductions(leftChanges, rightChanges, leftCounts);
		collectUnilateralReintroductions(rightChanges, leftChanges, rightCounts);
	}

	return mergeBaseRanges(ranges);
}

function countLinesAfterChanges(
	baseLines: string[],
	changes: LineChange[],
): Map<string, number> {
	const counts = new Map<string, number>();
	const adjust = (line: string, delta: number) => {
		const next = (counts.get(line) ?? 0) + delta;
		if (next === 0) counts.delete(line);
		else counts.set(line, next);
	};

	for (const line of baseLines) adjust(line, 1);
	for (const change of changes) {
		for (const line of baseLines.slice(change.baseStart, change.baseEnd)) {
			adjust(line, -1);
		}
		for (const line of change.lines) adjust(line, 1);
	}
	return counts;
}
function collectAmbiguousRepeatedLineAlignmentRanges(
	baseLines: string[],
	leftChanges: LineChange[],
	rightChanges: LineChange[],
): BaseRange[] {
	const ranges: BaseRange[] = [];
	for (const left of leftChanges) {
		for (const right of rightChanges) {
			const bridgeRange = baseBridgeRangeBetween(left, right);
			if (!bridgeRange) continue;
			const bridge = baseLines.slice(bridgeRange.start, bridgeRange.end);
			if (
				containsLineSubsequence(left.lines, bridge) &&
				containsLineSubsequence(right.lines, bridge)
			) {
				ranges.push({
					start: Math.min(left.baseStart, right.baseStart),
					end: Math.max(left.baseEnd, right.baseEnd),
				});
			}
		}
	}
	return mergeBaseRanges(ranges);
}

function baseBridgeRangeBetween(
	left: LineChange,
	right: LineChange,
): BaseRange | null {
	if (left.baseEnd < right.baseStart) {
		return { start: left.baseEnd, end: right.baseStart };
	}
	if (right.baseEnd < left.baseStart) {
		return { start: right.baseEnd, end: left.baseStart };
	}
	return null;
}

function mergeBaseRanges(ranges: BaseRange[]): BaseRange[] {
	const sorted = ranges
		.map((range) => ({ ...range }))
		.sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: BaseRange[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end) {
			last.end = Math.max(last.end, range.end);
		} else {
			merged.push(range);
		}
	}
	return merged;
}

function combineDistinctChanges(
	leftChanges: LineChange[],
	rightChanges: LineChange[],
): LineChange[] {
	const candidates = [...leftChanges, ...rightChanges];
	return candidates.filter((candidate, index) => {
		return candidates.findIndex((other) => lineChangesEqual(other, candidate)) === index;
	});
}

function rangesTouch(left: LineChange, right: LineChange): boolean {
	return left.baseStart <= right.baseEnd && right.baseStart <= left.baseEnd;
}

function applyNonConflictingChanges(
	baseLines: string[],
	leftChanges: LineChange[],
	rightChanges: LineChange[],
): string {
	const changes = combineDistinctChanges(leftChanges, rightChanges)
		.sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);
	const output: string[] = [];
	let cursor = 0;
	for (const change of changes) {
		output.push(...baseLines.slice(cursor, change.baseStart));
		output.push(...change.lines);
		cursor = change.baseEnd;
	}
	output.push(...baseLines.slice(cursor));
	return output.join("");
}

function buildConflictResult(
	baseLines: string[],
	leftChanges: LineChange[],
	rightChanges: LineChange[],
	conflictRanges: BaseRange[],
): Extract<ThreeWayMergeResult, { kind: "conflict" }> {
	const segments: ThreeWayMergeSegment[] = [];
	const hunks: ThreeWayMergeConflictHunk[] = [];
	const safeLeftChanges = excludeConflictChanges(leftChanges, conflictRanges);
	const safeRightChanges = excludeConflictChanges(rightChanges, conflictRanges);
	let cursor = 0;

	for (const range of conflictRanges) {
		if (cursor < range.start) {
			segments.push({
				kind: "text",
				text: applyRegion(
					baseLines,
					safeLeftChanges,
					safeRightChanges,
					cursor,
					range.start,
				),
			});
		}

		const hunk: ThreeWayMergeConflictHunk = {
			index: hunks.length,
			baseStart: range.start,
			baseEnd: range.end,
			baseText: baseLines.slice(range.start, range.end).join(""),
			leftText: applyVariantRegion(baseLines, leftChanges, range.start, range.end),
			rightText: applyVariantRegion(baseLines, rightChanges, range.start, range.end),
		};
		hunks.push(hunk);
		segments.push({ kind: "conflict", hunkIndex: hunk.index });
		cursor = range.end;
	}

	if (cursor < baseLines.length) {
		segments.push({
			kind: "text",
			text: applyRegion(
				baseLines,
				safeLeftChanges,
				safeRightChanges,
				cursor,
				baseLines.length,
			),
		});
	}

	const partialMergedText = segments.map((segment) => {
		if (segment.kind === "text") return segment.text;
		const hunk = hunks[segment.hunkIndex]!;
		return [
			"<<<<<<< LEFT\n",
			hunk.leftText,
			hunk.leftText.endsWith("\n") || hunk.leftText.length === 0 ? "" : "\n",
			"=======\n",
			hunk.rightText,
			hunk.rightText.endsWith("\n") || hunk.rightText.length === 0 ? "" : "\n",
			">>>>>>> RIGHT\n",
		].join("");
	}).join("");

	return { kind: "conflict", partialMergedText, hunks, segments };
}

function excludeConflictChanges(
	changes: LineChange[],
	conflictRanges: BaseRange[],
): LineChange[] {
	return changes.filter((change) => !conflictRanges.some((range) =>
		range.start <= change.baseStart && change.baseEnd <= range.end));
}

function applyRegion(
	baseLines: string[],
	leftChanges: LineChange[],
	rightChanges: LineChange[],
	start: number,
	end: number,
): string {
	const regionChanges = combineDistinctChanges(leftChanges, rightChanges)
		.filter((change) => start <= change.baseStart && change.baseEnd <= end)
		.sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);
	const output: string[] = [];
	let cursor = start;
	for (const change of regionChanges) {
		output.push(...baseLines.slice(cursor, change.baseStart));
		output.push(...change.lines);
		cursor = change.baseEnd;
	}
	output.push(...baseLines.slice(cursor, end));
	return output.join("");
}

function applyVariantRegion(
	baseLines: string[],
	changes: LineChange[],
	start: number,
	end: number,
): string {
	const output: string[] = [];
	let cursor = start;
	for (const change of changes) {
		if (change.baseEnd < start || change.baseStart > end) continue;
		output.push(...baseLines.slice(cursor, Math.max(cursor, change.baseStart)));
		output.push(...change.lines);
		cursor = Math.max(cursor, change.baseEnd);
	}
	output.push(...baseLines.slice(cursor, end));
	return output.join("");
}
