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

console.log("\n--- Test 11: one side already containing the other side's change merges without duplication ---");
{
	const base = "## 업무\n기본 업무\n\n## 일상\n기본 일상\n";
	const alreadyMerged = "## 업무\n편집기 업무\n\n## 일상\n외부 일상\n";
	const external = "## 업무\n기본 업무\n\n## 일상\n외부 일상\n";
	const result = mergeTexts3(base, alreadyMerged, external);
	assert.equal(result.kind, "clean-merge");
	assert.equal(
		result.kind === "clean-merge" ? result.mergedText : "",
		alreadyMerged,
	);
	const symmetric = mergeTexts3(base, external, alreadyMerged);
	assert.equal(symmetric.kind, "clean-merge");
	assert.equal(
		symmetric.kind === "clean-merge" ? symmetric.mergedText : "",
		alreadyMerged,
	);
}

console.log("\n--- Test 12: a shared insertion is applied once alongside independent changes ---");
{
	const base = "a\nb\nc\nd\ne\n";
	const left = "shared\na\nleft b\nc\nd\ne\n";
	const right = "shared\na\nb\nc\nd\nright e\n";
	const result = mergeTexts3(base, left, right);
	assert.equal(result.kind, "clean-merge");
	assert.equal(
		result.kind === "clean-merge" ? result.mergedText : "",
		"shared\na\nleft b\nc\nd\nright e\n",
	);
}

console.log("\n--- Test 13: a shared deletion is applied once alongside independent changes ---");
{
	const base = "drop\na\nb\nc\nd\n";
	const left = "a\nleft b\nc\nd\n";
	const right = "a\nb\nc\nright d\n";
	const result = mergeTexts3(base, left, right);
	assert.equal(result.kind, "clean-merge");
	assert.equal(
		result.kind === "clean-merge" ? result.mergedText : "",
		"a\nleft b\nc\nright d\n",
	);
}

console.log("\n--- Test 14: shared text inside a genuinely different hunk remains a conflict ---");
{
	const result = mergeTexts3(
		"a\nb\n",
		"shared\nleft a\nb\n",
		"shared\nright a\nb\n",
	);
	assert.equal(result.kind, "conflict");
	if (result.kind === "conflict") {
		assert.equal(result.hunks.length, 1);
		assert.equal(result.hunks[0]?.leftText, "shared\nleft a\n");
		assert.equal(result.hunks[0]?.rightText, "shared\nright a\n");
	}
}

console.log("\n--- Test 15: a distinct insertion superset conflicts with its subset ---");
{
	const base = "# Alternating soak\n";
	const predecessor = `${base}editor-01\n`;
	const successor = `${predecessor}filesystem-02\n`;
	for (const [left, right] of [
		[predecessor, successor],
		[successor, predecessor],
	] as const) {
		assert.equal(mergeTexts3(base, left, right).kind, "conflict");
	}
}

console.log("\n--- Test 16: an ambiguous insertion superset blocks the whole automatic merge ---");
{
	const base = "a\nb\nc\ntail\n";
	const left = "left a\nb\nc\ntail\nshared\n";
	const right = "a\nb\nright c\ntail\nshared\nexternal\n";
	for (const [first, second] of [
		[left, right],
		[right, left],
	] as const) {
		assert.equal(mergeTexts3(base, first, second).kind, "conflict");
	}
}

console.log("\n--- Test 17: partial overlap at one insertion point remains a conflict ---");
{
	const base = "anchor\n";
	const left = `${base}shared\nleft\n`;
	const right = `${base}right\nshared\n`;
	assert.equal(mergeTexts3(base, left, right).kind, "conflict");
	assert.equal(mergeTexts3(base, right, left).kind, "conflict");
}

console.log("\n--- Test 18: a same-range replacement superset conflicts with its subset ---");
{
	const base = "a\n";
	const subset = "A\n";
	const superset = "A\nB\n";
	for (const [left, right] of [
		[subset, superset],
		[superset, subset],
	] as const) {
		assert.equal(mergeTexts3(base, left, right).kind, "conflict");
	}
}

console.log("\n--- Test 19: one wider replacement cannot be reused to subsume distinct hunks ---");
{
	const base = "a\nb\nc\n";
	const twoDistinctEdits = "X\nb\nX\n";
	const oneWiderEdit = "X\n";
	assert.equal(mergeTexts3(base, twoDistinctEdits, oneWiderEdit).kind, "conflict");
	assert.equal(mergeTexts3(base, oneWiderEdit, twoDistinctEdits).kind, "conflict");
}

console.log("\n--- Test 20: a wider replacement without boundary containment remains a conflict ---");
{
	const base = "a\nb\n";
	const narrow = "A\nb\n";
	const widerSibling = "X\nB\n";
	assert.equal(mergeTexts3(base, narrow, widerSibling).kind, "conflict");
	assert.equal(mergeTexts3(base, widerSibling, narrow).kind, "conflict");
}

console.log("\n--- Test 21: an ordered same-range superset remains ambiguous ---");
{
	const base = "anchor\n";
	const subset = `${base}A\nC\n`;
	const superset = `${base}A\nB\nC\n`;
	for (const [left, right] of [
		[subset, superset],
		[superset, subset],
	] as const) {
		assert.equal(mergeTexts3(base, left, right).kind, "conflict");
	}
}

console.log("\n--- Test 22: structural subsumption preserves order and multiplicity ---");
{
	const base = "anchor\n";
	const ordered = `${base}A\nB\n`;
	const reordered = `${base}B\nA\n`;
	assert.equal(mergeTexts3(base, ordered, reordered).kind, "conflict");
	assert.equal(mergeTexts3(base, reordered, ordered).kind, "conflict");

	const duplicate = `${base}A\nA\n`;
	const insufficient = `${base}A\nB\nC\n`;
	assert.equal(mergeTexts3(base, duplicate, insufficient).kind, "conflict");
	assert.equal(mergeTexts3(base, insufficient, duplicate).kind, "conflict");
}

console.log("\n--- Test 23: generated ordered supersets and near-misses conflict symmetrically ---");
{
	const base = "anchor\n";
	for (let seed = 0; seed < 24; seed++) {
		const subsetLines = Array.from(
			{ length: 2 + (seed % 4) },
			(_, index) => `seed-${seed}-shared-${index}\n`,
		);
		const supersetLines = subsetLines.flatMap((line, index) => [
			line,
			`seed-${seed}-extra-${index}\n`,
		]);
		const subset = base + subsetLines.join("");
		const superset = base + supersetLines.join("");
		for (const [left, right] of [
			[subset, superset],
			[superset, subset],
		] as const) {
			assert.equal(mergeTexts3(base, left, right).kind, "conflict");
		}

		const nearMissLines = supersetLines.slice();
		nearMissLines[2 * (seed % subsetLines.length)] = `seed-${seed}-changed\n`;
		const nearMiss = base + nearMissLines.join("");
		assert.equal(mergeTexts3(base, subset, nearMiss).kind, "conflict");
		assert.equal(mergeTexts3(base, nearMiss, subset).kind, "conflict");
	}
}

console.log("\n--- Test 24: repeated-line occurrence ambiguity conflicts without phantom duplication ---");
{
	const base = "A\n";
	const leftVariant = "A\nA\n";
	const rightVariant = "B\nA\nA\n";
	for (const [left, right] of [
		[leftVariant, rightVariant],
		[rightVariant, leftVariant],
	] as const) {
		const result = mergeTexts3(base, left, right);
		assert.equal(result.kind, "conflict");
		if (result.kind === "conflict") {
			assert.equal(result.hunks.length, 1);
			assert.equal(result.hunks[0]?.baseText, base);
			assert.equal(result.hunks[0]?.leftText, left);
			assert.equal(result.hunks[0]?.rightText, right);
		}
	}
}

console.log("\n--- Test 25: ambiguous repeated-line mapping without insertion-only proof conflicts ---");
{
	const base = "D\nA\n";
	const insertionOnlySide = "D\nA\nA\n";
	const replacingSide = "right D\nB\nA\nA\n";
	assert.equal(mergeTexts3(base, insertionOnlySide, replacingSide).kind, "conflict");
	assert.equal(mergeTexts3(base, replacingSide, insertionOnlySide).kind, "conflict");
}

console.log("\n--- Test 26: repeated insertions separated by a unique anchor remain independent ---");
{
	const base = "A\nmiddle\nZ\n";
	const left = "A\nA\nmiddle\nZ\n";
	const right = "A\nmiddle\nA\nZ\n";
	const expected = "A\nA\nmiddle\nA\nZ\n";
	for (const [first, second] of [
		[left, right],
		[right, left],
	] as const) {
		const result = mergeTexts3(base, first, second);
		assert.equal(result.kind, "clean-merge");
		assert.equal(result.kind === "clean-merge" ? result.mergedText : "", expected);
	}
}

console.log("\n--- Test 27: deletion and a distant insertion do not masquerade as a successor ---");
{
	const base = "A\nB\n";
	const deletion = "A\n";
	const insertion = "X\nA\nB\n";
	const expected = "X\nA\n";
	for (const [left, right] of [
		[deletion, insertion],
		[insertion, deletion],
	] as const) {
		const result = mergeTexts3(base, left, right);
		assert.equal(result.kind, "clean-merge");
		assert.equal(result.kind === "clean-merge" ? result.mergedText : "", expected);
	}
}

console.log("\n--- Test 28: ambiguous repeated alignment keeps an independent prefix outside the local conflict ---");
{
	const base = "top\nhead\nA\n";
	const left = "left top\nhead\nA\nA\n";
	const right = "top\nhead\nB\nA\nA\n";
	const result = mergeTexts3(base, left, right);
	assert.equal(result.kind, "conflict");
	if (result.kind === "conflict") {
		assert.equal(result.hunks.length, 1);
		assert.deepEqual(result.hunks[0], {
			index: 0,
			baseStart: 2,
			baseEnd: 3,
			baseText: "A\n",
			leftText: "A\nA\n",
			rightText: "B\nA\nA\n",
		});
		assert.deepEqual(result.segments, [
			{ kind: "text", text: "left top\nhead\n" },
			{ kind: "conflict", hunkIndex: 0 },
		]);
	}
}

console.log("\n--- Test 29: moving a line conflicts with deleting that line ---");
{
	const base = "A\nB\nC\n";
	const deleted = "A\nC\n";
	const moved = "A\nC\nB\n";
	assert.equal(mergeTexts3(base, deleted, moved).kind, "conflict");
	assert.equal(mergeTexts3(base, moved, deleted).kind, "conflict");
}

console.log("\n--- Test 30: moving a whitespace-only line conflicts with deleting it ---");
{
	const base = "A\n\nB\n";
	const deleted = "A\nB\n";
	const moved = "A\nB\n\n";
	assert.equal(mergeTexts3(base, deleted, moved).kind, "conflict");
	assert.equal(mergeTexts3(base, moved, deleted).kind, "conflict");
}

console.log("\n--- Test 31: moving the same line to different destinations conflicts ---");
{
	const base = "A\nB\nC\nD\n";
	const movedAfterC = "A\nC\nB\nD\n";
	const movedAfterD = "A\nC\nD\nB\n";
	assert.equal(mergeTexts3(base, movedAfterC, movedAfterD).kind, "conflict");
	assert.equal(mergeTexts3(base, movedAfterD, movedAfterC).kind, "conflict");
}

console.log("\n--- Test 32: a shared deletion still merges an unrelated insertion ---");
{
	const base = "A\nB\nC\n";
	const deleted = "A\nC\n";
	const deletedWithUnrelatedInsertion = "X\nA\nC\n";
	const expected = deletedWithUnrelatedInsertion;
	for (const [left, right] of [
		[deleted, deletedWithUnrelatedInsertion],
		[deletedWithUnrelatedInsertion, deleted],
	] as const) {
		const result = mergeTexts3(base, left, right);
		assert.equal(result.kind, "clean-merge");
		assert.equal(result.kind === "clean-merge" ? result.mergedText : "", expected);
	}
}

console.log("\n--- Test 33: reintroducing a commonly replaced line elsewhere conflicts ---");
{
	const base = "A\nB\nC\n";
	const replaced = "A\nX\nC\n";
	const replacedAndReintroduced = "B\nA\nX\nC\n";
	assert.equal(mergeTexts3(base, replaced, replacedAndReintroduced).kind, "conflict");
	assert.equal(mergeTexts3(base, replacedAndReintroduced, replaced).kind, "conflict");
}

console.log("\n--- Test 34: repeated-line removal and reinsertion is count-aware ---");
{
	const base = "A\nA\nB\n";
	const deleted = "A\nB\n";
	const moved = "A\nB\nA\n";
	assert.equal(mergeTexts3(base, deleted, moved).kind, "conflict");
	assert.equal(mergeTexts3(base, moved, deleted).kind, "conflict");
}

console.log("\n--- Test 35: a reordered subset of a shared deleted block conflicts ---");
{
	const base = "A\nB\nC\nD\nE\n";
	const deleted = "A\nD\nE\n";
	const reorderedMove = "A\nD\nC\nB\nE\n";
	assert.equal(mergeTexts3(base, deleted, reorderedMove).kind, "conflict");
	assert.equal(mergeTexts3(base, reorderedMove, deleted).kind, "conflict");
}

console.log("\n--- Test 36: a shared replacement still merges an unrelated insertion ---");
{
	const base = "A\nB\nC\n";
	const replaced = "A\nX\nC\n";
	const replacedWithUnrelatedInsertion = "Z\nA\nX\nC\n";
	for (const [left, right] of [
		[replaced, replacedWithUnrelatedInsertion],
		[replacedWithUnrelatedInsertion, replaced],
	] as const) {
		const result = mergeTexts3(base, left, right);
		assert.equal(result.kind, "clean-merge");
		assert.equal(
			result.kind === "clean-merge" ? result.mergedText : "",
			replacedWithUnrelatedInsertion,
		);
	}
}

console.log("\n--- Test 37: an agreed move still merges distant independent edits ---");
{
	const base = "p\nq\nA\nB\nC\nD\nE\nr\ns\n";
	const left = "left p\nq\nA\nB\nD\nE\nC\nr\ns\n";
	const right = "p\nq\nA\nB\nD\nE\nC\nr\nright s\n";
	const expected = "left p\nq\nA\nB\nD\nE\nC\nr\nright s\n";
	for (const [first, second] of [
		[left, right],
		[right, left],
	] as const) {
		const result = mergeTexts3(base, first, second);
		assert.equal(result.kind, "clean-merge");
		assert.equal(result.kind === "clean-merge" ? result.mergedText : "", expected);
	}
}

console.log("\n--- Test 38: generated exact moves never revive deletion-only lines ---");
{
	const permutations = (values: string[]): string[][] => {
		if (values.length < 2) return [values];
		const result: string[][] = [];
		for (let index = 0; index < values.length; index++) {
			for (const tail of permutations([
				...values.slice(0, index),
				...values.slice(index + 1),
			])) {
				result.push([values[index]!, ...tail]);
			}
		}
		return result;
	};
	const baseLines = ["A", "B", "C", "D", "E"];
	const base = baseLines.map((line) => `${line}\n`).join("");
	let cleanMergeCount = 0;
	for (const movedLines of permutations(baseLines)) {
		const moved = movedLines.map((line) => `${line}\n`).join("");
		for (let mask = 0; mask < (1 << baseLines.length); mask++) {
			const keptLines = baseLines.filter((_, index) => (mask & (1 << index)) !== 0);
			if (keptLines.length === baseLines.length) continue;
			const deletedLines = baseLines.filter((line) => !keptLines.includes(line));
			const deleted = keptLines.map((line) => `${line}\n`).join("");
			for (const [left, right] of [
				[deleted, moved],
				[moved, deleted],
			] as const) {
				const result = mergeTexts3(base, left, right);
				if (result.kind !== "clean-merge") continue;
				cleanMergeCount++;
				const mergedLines = result.mergedText.split("\n").filter(Boolean);
				for (const deletedLine of deletedLines) {
					assert.equal(
						mergedLines.includes(deletedLine),
						false,
						`clean merge revived ${deletedLine}: ${JSON.stringify({
							keptLines,
							movedLines,
							mergedLines,
						})}`,
					);
				}
			}
		}
	}
	assert(cleanMergeCount > 0, "generated matrix retains valid clean deletion merges");
}

console.log("\n--- Test 39: different repeated-line occurrences can be edited independently ---");
{
	const base = "start\nX\nmid\nX\nend\n";
	const left = "start\nL\nmid\nX\nend\n";
	const right = "start\nX\nmid\nR\nend\n";
	const expected = "start\nL\nmid\nR\nend\n";
	for (const [first, second] of [[left, right], [right, left]] as const) {
		const result = mergeTexts3(base, first, second);
		assert.equal(result.kind, "clean-merge");
		assert.equal(result.kind === "clean-merge" ? result.mergedText : "", expected);
	}
}

console.log("\n--- Test 40: different repeated-line occurrences can be deleted independently ---");
{
	const base = "start\nX\nmid\nX\nend\n";
	const left = "start\nmid\nX\nend\n";
	const right = "start\nX\nmid\nend\n";
	const expected = "start\nmid\nend\n";
	for (const [first, second] of [[left, right], [right, left]] as const) {
		const result = mergeTexts3(base, first, second);
		assert.equal(result.kind, "clean-merge");
		assert.equal(result.kind === "clean-merge" ? result.mergedText : "", expected);
	}
}

console.log("\n--- Test 41: independent removals of different unique lines still merge ---");
{
	const base = "A\nkeep\nB\n";
	const left = "keep\nB\n";
	const right = "A\nkeep\n";
	const expected = "keep\n";
	for (const [first, second] of [
		[left, right],
		[right, left],
	] as const) {
		const result = mergeTexts3(base, first, second);
		assert.equal(result.kind, "clean-merge");
		assert.equal(result.kind === "clean-merge" ? result.mergedText : "", expected);
	}
}

console.log("\n--- Test 42: moving a surviving repeated line does not revive the shared deletion ---");
{
	const base = "A\nX\nB\nY\nX\nZ\n";
	const sharedDeletion = "A\nB\nY\nX\nZ\n";
	const deletionWithSurvivingMove = "A\nB\nX\nY\nZ\n";
	for (const [left, right] of [
		[sharedDeletion, deletionWithSurvivingMove],
		[deletionWithSurvivingMove, sharedDeletion],
	] as const) {
		const result = mergeTexts3(base, left, right);
		assert.equal(result.kind, "clean-merge");
		assert.equal(
			result.kind === "clean-merge" ? result.mergedText : "",
			deletionWithSurvivingMove,
		);
	}
}
