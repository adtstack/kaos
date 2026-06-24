import assert from "node:assert/strict";
import { renderDiffLines, renderDiffText } from "../src/utils/textDiff";

console.log("\n--- Test 1: renderDiffText marks whole inserted and deleted lines ---");
{
	const output = renderDiffText("one\ntwo\n", "one\nthree\n");
	assert(output.includes("- two"), "deleted line is prefixed");
	assert(output.includes("+ three"), "inserted line is prefixed");
}

console.log("\n--- Test 2: renderDiffText handles equal text ---");
{
	assert.equal(renderDiffText("same", "same"), "  same");
}

console.log("\n--- Test 3: renderDiffText limits large output ---");
{
	const previous = Array.from({ length: 80 }, (_, i) => `old-${i}`).join("\n");
	const current = Array.from({ length: 80 }, (_, i) => `new-${i}`).join("\n");
	const output = renderDiffText(previous, current, {
		maxSegments: 1,
		maxLinesPerSegment: 2,
	});
	assert(output.endsWith("  ..."), "limited output is marked with ellipsis");
}

console.log("\n--- Test 4: renderDiffLines returns line-level kinds ---");
{
	const output = renderDiffLines("one\ntwo\n", "one\nthree\n");
	assert.deepEqual(output, [
		{ kind: "equal", text: "one" },
		{ kind: "delete", text: "two" },
		{ kind: "insert", text: "three" },
	]);
}

console.log("\n--- Test 5: renderDiffLines compacts unchanged context ---");
{
	const previousLines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
	const currentLines = previousLines.slice();
	currentLines[14] = "line-15 changed";
	const output = renderDiffLines(previousLines.join("\n"), currentLines.join("\n"), {
		contextLines: 2,
	});
	assert.deepEqual(output, [
		{ kind: "context", text: "..." },
		{ kind: "equal", text: "line-13" },
		{ kind: "equal", text: "line-14" },
		{ kind: "delete", text: "line-15" },
		{ kind: "insert", text: "line-15 changed" },
		{ kind: "equal", text: "line-16" },
		{ kind: "equal", text: "line-17" },
		{ kind: "context", text: "..." },
	]);
}
