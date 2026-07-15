import assert from "node:assert/strict";
import {
	commitPendingBlobIntentWithWriteAhead,
	type PendingBlobIntentCommitHooks,
} from "../src/sync/pendingBlobIntentCommit";
import {
	PendingBlobIntentJournal,
	type PendingBlobIntentScope,
} from "../src/sync/pendingBlobIntentJournal";
import type { BlobRef } from "../src/types";

type Result = { kind: "committed" | "conflict" };

function deferred(): {
	promise: Promise<void>;
	resolve(): void;
	reject(error: unknown): void;
} {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function fixture(overrides: Partial<PendingBlobIntentCommitHooks<Result>> = {}) {
	const calls: string[] = [];
	const hooks: PendingBlobIntentCommitHooks<Result> = {
		markAttempted: () => { calls.push("mark-attempted"); return true; },
		persistAttempted: async () => { calls.push("persist-attempted"); },
		isAttemptCurrent: () => { calls.push("check-current"); return true; },
		apply: () => { calls.push("apply"); return { kind: "committed" }; },
		isApplyCurrent: () => { calls.push("check-post-apply"); return true; },
		isKnownNoMutation: (result) => result.kind === "conflict",
		clearAttempt: () => { calls.push("clear-attempt"); return true; },
		markCommitted: () => { calls.push("mark-committed"); return true; },
		persistFinal: async () => { calls.push("persist-final"); },
		flushReceipt: async () => { calls.push("flush-receipt"); },
		...overrides,
	};
	return { hooks, calls };
}

console.log("\n--- Pending blob intent commit: CAS waits for durable write-ahead ---");
{
	const writeAhead = deferred();
	let applyCount = 0;
	const { hooks } = fixture({
		persistAttempted: () => writeAhead.promise,
		apply: () => { applyCount++; return { kind: "committed" }; },
	});
	const run = commitPendingBlobIntentWithWriteAhead(hooks);
	await Promise.resolve();
	assert.equal(applyCount, 0, "CAS must not run while phase-one persistence is pending");
	writeAhead.resolve();
	assert.equal((await run).kind, "committed");
	assert.equal(applyCount, 1);
}

console.log("\n--- Pending blob intent commit: failed or stale write-ahead runs zero CAS ---");
{
	let applyCount = 0;
	const failure = new Error("idb unavailable");
	const failed = fixture({
		persistAttempted: async () => { throw failure; },
		apply: () => { applyCount++; return { kind: "committed" }; },
	});
	const failedOutcome = await commitPendingBlobIntentWithWriteAhead(failed.hooks);
	assert.equal(failedOutcome.kind, "attempt-persist-failed");
	assert.equal(applyCount, 0);

	const stale = fixture({
		isAttemptCurrent: () => false,
		apply: () => { applyCount++; return { kind: "committed" }; },
	});
	assert.equal(
		(await commitPendingBlobIntentWithWriteAhead(stale.hooks)).kind,
		"stale-after-attempt",
	);
	assert.equal(applyCount, 0);
}

console.log("\n--- Pending blob intent commit: apply ambiguity retains attempted fence ---");
{
	let clearCount = 0;
	let commitCount = 0;
	let finalPersistCount = 0;
	const run = fixture({
		apply: () => { throw new Error("unknown CAS outcome"); },
		clearAttempt: () => { clearCount++; return true; },
		markCommitted: () => { commitCount++; return true; },
		persistFinal: async () => { finalPersistCount++; },
	});
	const outcome = await commitPendingBlobIntentWithWriteAhead(run.hooks);
	assert.equal(outcome.kind, "ambiguous");
	assert.equal(clearCount, 0);
	assert.equal(commitCount, 0);
	assert.equal(finalPersistCount, 0);
}

console.log("\n--- Pending blob intent commit: post-apply authority loss stays ambiguous ---");
{
	let clearCount = 0;
	let commitCount = 0;
	const run = fixture({
		isApplyCurrent: () => false,
		clearAttempt: () => { clearCount++; return true; },
		markCommitted: () => { commitCount++; return true; },
	});
	const outcome = await commitPendingBlobIntentWithWriteAhead(run.hooks);
	assert.equal(outcome.kind, "ambiguous");
	assert.equal(outcome.kind === "ambiguous" ? outcome.stage : "", "postcondition");
	assert.equal(clearCount, 0);
	assert.equal(commitCount, 0);
}

console.log("\n--- Pending blob intent commit: known no-mutation clears durably ---");
{
	let receiptCount = 0;
	const run = fixture({
		apply: () => ({ kind: "conflict" }),
		flushReceipt: async () => { receiptCount++; },
	});
	const outcome = await commitPendingBlobIntentWithWriteAhead(run.hooks);
	assert.equal(outcome.kind, "known-no-mutation");
	assert.deepEqual(run.calls, [
		"mark-attempted",
		"persist-attempted",
		"check-current",
		"check-post-apply",
		"clear-attempt",
		"persist-final",
	]);
	assert.equal(receiptCount, 0);

	const failedClear = fixture({
		apply: () => ({ kind: "conflict" }),
		persistFinal: async () => { throw new Error("clear not durable"); },
	});
	assert.equal(
		(await commitPendingBlobIntentWithWriteAhead(failedClear.hooks)).kind,
		"clear-persist-failed",
	);
}

console.log("\n--- Pending blob intent commit: phase two and receipt settle independently ---");
{
	const finalWrite = deferred();
	const receiptWrite = deferred();
	let finalStarted = 0;
	let receiptStarted = 0;
	const run = fixture({
		persistFinal: () => { finalStarted++; return finalWrite.promise; },
		flushReceipt: () => { receiptStarted++; return receiptWrite.promise; },
	});
	const outcomePromise = commitPendingBlobIntentWithWriteAhead(run.hooks);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(finalStarted, 1, "phase-two journal write starts immediately after CAS");
	assert.equal(receiptStarted, 1, "receipt persistence starts without waiting for phase two");
	finalWrite.resolve();
	receiptWrite.resolve();
	assert.equal((await outcomePromise).kind, "committed");

	const receiptFailure = fixture({
		flushReceipt: async () => { throw new Error("receipt failed"); },
	});
	const receiptOutcome = await commitPendingBlobIntentWithWriteAhead(receiptFailure.hooks);
	assert.equal(receiptOutcome.kind, "committed");
	assert.ok("receiptError" in receiptOutcome);

	const finalFailure = fixture({
		persistFinal: async () => { throw new Error("phase two failed"); },
	});
	assert.equal(
		(await commitPendingBlobIntentWithWriteAhead(finalFailure.hooks)).kind,
		"commit-persist-failed",
	);
}

console.log("\n--- Pending blob intent commit: crash-after-CAS blocks H1 ABA replay ---");
{
	const scope: PendingBlobIntentScope = {
		host: "https://sync.example.test",
		vaultId: "vault-a",
		localDeviceId: "device-a",
	};
	const h1: BlobRef = { hash: "a".repeat(64), size: 17 };
	const beforeCrash = new PendingBlobIntentJournal();
	const intent = beforeCrash.recordDelete(
		"assets/aba.png",
		scope,
		{
			known: true,
			ref: h1,
			sourceVersionKnown: true,
			expectedSourceVersion: "1:1",
		},
		100,
	);
	let durable = beforeCrash.getEntries(scope);
	let remoteRef: BlobRef | undefined = h1;
	let casCount = 0;
	const firstRun = fixture({
		markAttempted: () => beforeCrash.markCommitAttempted(
			intent.id,
			"attempt-before-crash",
			150,
			"session-before-crash",
		),
		persistAttempted: async () => { durable = beforeCrash.getEntries(scope); },
		isAttemptCurrent: () => true,
		apply: () => {
			casCount++;
			remoteRef = undefined;
			throw new Error("simulated process termination after CAS");
		},
	});
	assert.equal(
		(await commitPendingBlobIntentWithWriteAhead(firstRun.hooks)).kind,
		"ambiguous",
	);
	assert.equal(casCount, 1);
	assert.equal(remoteRef, undefined);

	// A different remote episode revives the same H1 before this device restarts.
	remoteRef = h1;
	const afterCrash = new PendingBlobIntentJournal(durable);
	const replay = fixture({
		markAttempted: () => afterCrash.markCommitAttempted(
			intent.id,
			"attempt-after-crash",
			250,
			"session-after-crash",
		),
		apply: () => {
			casCount++;
			remoteRef = undefined;
			return { kind: "committed" };
		},
	});
	assert.equal(
		(await commitPendingBlobIntentWithWriteAhead(replay.hooks)).kind,
		"not-started",
		"the durable attempted fence cannot be re-armed after restart",
	);
	assert.equal(casCount, 1, "the revived H1 is never deleted by the old intent again");
	assert.equal(remoteRef, h1);
}

console.log("Pending blob intent commit tests passed.");
