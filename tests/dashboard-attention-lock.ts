import assert from "node:assert/strict";
import { withAttentionResolutionLock } from "../src/dashboard/attentionResolutionLock";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

console.log("\n--- Dashboard Attention path lock ---");

const inFlight = new Set<string>();
const release = deferred<void>();
const first = withAttentionResolutionLock(
	inFlight,
	"markdown:notes/a.md",
	"notes/a.md",
	async () => {
		await release.promise;
		return "done";
	},
);

await assert.rejects(
	withAttentionResolutionLock(
		inFlight,
		"markdown:notes/a.md",
		"notes/a.md",
		async () => "overlap",
	),
	/already running/,
	"Keep and Accept cannot overlap on the same kind/path",
);

assert.equal(
	await withAttentionResolutionLock(
		inFlight,
		"blob:notes/a.md",
		"notes/a.md",
		async () => "independent-kind",
	),
	"independent-kind",
	"different pipelines do not share a false lock",
);

release.resolve();
assert.equal(await first, "done");
assert.equal(inFlight.size, 0, "the lock is released after success");

await assert.rejects(
	withAttentionResolutionLock(
		inFlight,
		"markdown:notes/failure.md",
		"notes/failure.md",
		async () => { throw new Error("trash failed"); },
	),
	/trash failed/,
);
assert.equal(inFlight.size, 0, "the lock is released after failure");

console.log("PASS dashboard Attention path lock");
