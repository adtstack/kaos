import diff from "fast-diff";

const LINE_TOKEN_BASE = 0xe000;
const MAX_LINE_TOKENS = 0xf8ff - LINE_TOKEN_BASE + 1;

export interface RenderDiffTextOptions {
	maxSegments?: number;
	maxLinesPerSegment?: number;
	contextLines?: number;
}

export type RenderedDiffLineKind = "equal" | "delete" | "insert" | "context";

export interface RenderedDiffLine {
	kind: RenderedDiffLineKind;
	text: string;
}

export function renderDiffLines(
	previous: string,
	current: string,
	options: RenderDiffTextOptions = {},
): RenderedDiffLine[] {
	const previousLines = splitLines(previous);
	const currentLines = splitLines(current);
	const maxLines = Math.max(1, (options.maxSegments ?? 24) * (options.maxLinesPerSegment ?? 8));
	const diffLines = compactDiffContext(
		buildLineDiff(previousLines, currentLines),
		options.contextLines,
	);
	if (diffLines.length <= maxLines) return diffLines;
	return diffLines.slice(0, maxLines).concat({ kind: "equal", text: "..." });
}

export function renderDiffText(
	previous: string,
	current: string,
	options: RenderDiffTextOptions = {},
): string {
	const lines = renderDiffLines(previous, current, options)
		.map((line) => `${prefixForKind(line.kind)}${line.text}`);
	return lines.join("\n") || "No textual diff.";
}

function buildLineDiff(previousLines: string[], currentLines: string[]): RenderedDiffLine[] {
	const encoded = encodeLineTokens(previousLines, currentLines);
	if (!encoded) {
		return [
			...previousLines.map((text) => ({ kind: "delete" as const, text })),
			...currentLines.map((text) => ({ kind: "insert" as const, text })),
		];
	}

	const output: RenderedDiffLine[] = [];
	for (const [kind, tokenText] of diff(encoded.previous, encoded.current, undefined, false)) {
		for (const token of tokenText) {
			const text = encoded.lines[token.charCodeAt(0) - LINE_TOKEN_BASE] ?? "";
			output.push({
				kind: kind === -1 ? "delete" : kind === 1 ? "insert" : "equal",
				text,
			});
		}
	}
	return output;
}

function compactDiffContext(
	lines: RenderedDiffLine[],
	contextLines: number | undefined,
): RenderedDiffLine[] {
	if (contextLines === undefined) return lines;
	const context = Math.max(0, Math.floor(contextLines));
	const changedIndexes = lines
		.map((line, index) => line.kind === "equal" ? -1 : index)
		.filter((index) => index >= 0);
	if (changedIndexes.length === 0) return [];

	const ranges: Array<{ start: number; end: number }> = [];
	for (const index of changedIndexes) {
		const next = {
			start: Math.max(0, index - context),
			end: Math.min(lines.length - 1, index + context),
		};
		const last = ranges[ranges.length - 1];
		if (last && next.start <= last.end + 1) {
			last.end = Math.max(last.end, next.end);
		} else {
			ranges.push(next);
		}
	}

	const output: RenderedDiffLine[] = [];
	let previousEnd = -1;
	for (const range of ranges) {
		if (range.start > previousEnd + 1) {
			output.push({ kind: "context", text: "..." });
		}
		output.push(...lines.slice(range.start, range.end + 1));
		previousEnd = range.end;
	}
	if (previousEnd < lines.length - 1) {
		output.push({ kind: "context", text: "..." });
	}
	return output;
}

function encodeLineTokens(
	previousLines: string[],
	currentLines: string[],
): { previous: string; current: string; lines: string[] } | null {
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

	const encode = (sourceLines: string[]): string | null => {
		let encoded = "";
		for (const line of sourceLines) {
			const token = tokenForLine(line);
			if (token === null) return null;
			encoded += token;
		}
		return encoded;
	};

	const previous = encode(previousLines);
	if (previous === null) return null;
	const current = encode(currentLines);
	if (current === null) return null;
	return { previous, current, lines };
}

function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split(/\r?\n/);
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function prefixForKind(kind: RenderedDiffLineKind): string {
	switch (kind) {
		case "delete": return "- ";
		case "insert": return "+ ";
		case "context": return "  ";
		case "equal": return "  ";
	}
}
