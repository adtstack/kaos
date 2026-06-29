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

	const conflictRanges = collectConflictRanges(leftChanges, rightChanges);
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
): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	for (const left of leftChanges) {
		for (const right of rightChanges) {
			if (!rangesTouch(left, right)) continue;
			const next = {
				start: Math.min(left.baseStart, right.baseStart),
				end: Math.max(left.baseEnd, right.baseEnd),
			};
			const last = ranges[ranges.length - 1];
			if (last && next.start <= last.end) {
				last.end = Math.max(last.end, next.end);
			} else {
				ranges.push(next);
			}
		}
	}
	return ranges;
}

function rangesTouch(left: LineChange, right: LineChange): boolean {
	return left.baseStart <= right.baseEnd && right.baseStart <= left.baseEnd;
}

function applyNonConflictingChanges(
	baseLines: string[],
	leftChanges: LineChange[],
	rightChanges: LineChange[],
): string {
	const changes = [...leftChanges, ...rightChanges]
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
	conflictRanges: Array<{ start: number; end: number }>,
): Extract<ThreeWayMergeResult, { kind: "conflict" }> {
	const segments: ThreeWayMergeSegment[] = [];
	const hunks: ThreeWayMergeConflictHunk[] = [];
	let cursor = 0;

	for (const range of conflictRanges) {
		if (cursor < range.start) {
			segments.push({
				kind: "text",
				text: applyRegion(baseLines, leftChanges, rightChanges, cursor, range.start),
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
			text: applyRegion(baseLines, leftChanges, rightChanges, cursor, baseLines.length),
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

function applyRegion(
	baseLines: string[],
	leftChanges: LineChange[],
	rightChanges: LineChange[],
	start: number,
	end: number,
): string {
	const regionChanges = [...leftChanges, ...rightChanges]
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
