import assert from "node:assert/strict";
import { mergeTexts3 } from "../src/utils/threeWayMerge";

console.log("\n--- Test 1: missing base reports no-base ---");
{
	assert.deepEqual(mergeTexts3(null, "left", "right"), { kind: "no-base" });
}

console.log("\n--- Test 2: one-sided changes clean-merge ---");
{
	const base = "one\ntwo\nthree\n";
	const disk = "one\ntwo local\nthree\n";
	const crdt = base;
	const result = mergeTexts3(base, disk, crdt);
	assert.equal(result.kind, "clean-merge");
	assert.equal(result.kind === "clean-merge" ? result.mergedText : "", disk);
}

console.log("\n--- Test 3: non-overlapping changes clean-merge ---");
{
	const base = "one\ntwo\nthree\nfour\n";
	const disk = "one\ntwo local\nthree\nfour\n";
	const crdt = "one\ntwo\nthree\nfour remote\n";
	const result = mergeTexts3(base, disk, crdt);
	assert.equal(result.kind, "clean-merge");
	assert.equal(result.kind === "clean-merge" ? result.mergedText : "", "one\ntwo local\nthree\nfour remote\n");
}

console.log("\n--- Test 4: same-line changes conflict ---");
{
	const result = mergeTexts3("title: old\n", "title: local\n", "title: remote\n");
	assert.equal(result.kind, "conflict");
	assert.equal(result.kind === "conflict" ? result.hunks.length : 0, 1);
}

console.log("\n--- Test 5: adjacent changes conflict conservatively ---");
{
	const base = "one\ntwo\nthree\n";
	const disk = "one\nlocal two\nthree\n";
	const crdt = "one\ntwo\nremote three\n";
	const result = mergeTexts3(base, disk, crdt);
	assert.equal(result.kind, "conflict");
}

console.log("\n--- Test 6: delete vs modify conflict ---");
{
	const base = "one\ntwo\nthree\n";
	const disk = "one\nthree\n";
	const crdt = "one\ntwo remote\nthree\n";
	const result = mergeTexts3(base, disk, crdt);
	assert.equal(result.kind, "conflict");
}

console.log("\n--- Test 7: trailing newline is preserved ---");
{
	const result = mergeTexts3("a\nb\nc\n", "a local\nb\nc\n", "a\nb\nc remote\n");
	assert.equal(result.kind, "clean-merge");
	assert.equal(result.kind === "clean-merge" ? result.mergedText.endsWith("\n") : false, true);
}

console.log("\n--- Test 8: empty base with independent insertions conflicts at same point ---");
{
	const result = mergeTexts3("", "left\n", "right\n");
	assert.equal(result.kind, "conflict");
}

console.log("\n--- Test 9: repeated lines non-overlapping changes clean-merge ---");
{
	const base = "x\nsame\nsame\nz\n";
	const disk = "x\ndisk\nsame\nz\n";
	const crdt = "x\nsame\nsame\nremote\n";
	const result = mergeTexts3(base, disk, crdt);
	assert.equal(result.kind, "clean-merge");
	assert.equal(result.kind === "clean-merge" ? result.mergedText : "", "x\ndisk\nsame\nremote\n");
}

console.log("\n--- Test 10: large document non-overlapping changes clean-merge ---");
{
	const baseLines = Array.from({ length: 400 }, (_, index) => `line-${index}\n`);
	const diskLines = baseLines.slice();
	const crdtLines = baseLines.slice();
	diskLines[50] = "disk-50\n";
	crdtLines[350] = "crdt-350\n";
	const result = mergeTexts3(baseLines.join(""), diskLines.join(""), crdtLines.join(""));
	assert.equal(result.kind, "clean-merge");
	assert.equal(result.kind === "clean-merge" ? result.mergedText.includes("disk-50\n") : false, true);
	assert.equal(result.kind === "clean-merge" ? result.mergedText.includes("crdt-350\n") : false, true);
}
