import assert from "node:assert/strict";
import {
	PendingBlobIntentJournal,
	pendingBlobIntentsOverlap,
	type PendingBlobIntent,
	type PendingBlobIntentScope,
} from "../src/sync/pendingBlobIntentJournal";
import type { BlobRef } from "../src/types";

const SCOPE: PendingBlobIntentScope = {
	host: "https://sync.example.test",
	vaultId: "vault-a",
	localDeviceId: "device-a",
};
const REF_H1: BlobRef = { hash: "a".repeat(64), size: 17 };
const REF_H2: BlobRef = { hash: "b".repeat(64), size: 23 };
const ATTEMPT_ID = "attempt-a";
const ATTEMPT_SESSION_ID = "attempt-session-a";

function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function onlyEntry(journal: PendingBlobIntentJournal): PendingBlobIntent {
	const entries = journal.getEntries(SCOPE);
	assert.equal(entries.length, 1);
	return entries[0]!;
}

function markOnlyEntryAttempted(
	journal: PendingBlobIntentJournal,
	commitAttemptId = ATTEMPT_ID,
): PendingBlobIntent {
	const entry = onlyEntry(journal);
	assert.equal(
		journal.markCommitAttempted(
			entry.id,
			commitAttemptId,
			150,
			ATTEMPT_SESSION_ID,
		),
		true,
	);
	return onlyEntry(journal);
}

function readyDelete(path = "assets/a.png"): PendingBlobIntentJournal {
	const journal = new PendingBlobIntentJournal();
	journal.recordDelete(path, SCOPE, {
		known: true,
		ref: REF_H1,
		sourceVersionKnown: true,
		expectedSourceVersion: "1:1",
	}, 100);
	return journal;
}

function readyRename(
	oldPath = "assets/a.png",
	newPath = "assets/b.png",
): PendingBlobIntentJournal {
	const journal = new PendingBlobIntentJournal();
	assert.ok(journal.recordRename(
		oldPath,
		newPath,
		SCOPE,
		{
			known: true,
			ref: REF_H1,
			sourceVersionKnown: true,
			expectedSourceVersion: "1:1",
		},
		100,
	));
	return journal;
}

console.log("\n--- Pending blob intent write-ahead: ready -> attempted -> committed ---");
{
	const journal = readyDelete();
	const ready = onlyEntry(journal);
	assert.equal(ready.commitAttemptId, undefined);
	assert.equal(ready.committedAt, undefined);

	assert.equal(
		journal.markCommitAttempted(
			ready.id,
			ATTEMPT_ID,
			150,
			ATTEMPT_SESSION_ID,
		),
		true,
	);
	assert.deepEqual(onlyEntry(journal), {
		...ready,
		commitAttemptId: ATTEMPT_ID,
		attemptedAt: 150,
		attemptSessionId: ATTEMPT_SESSION_ID,
	});
	assert.equal(
		journal.markCommitAttempted(ready.id, "new-attempt", 151, "new-session"),
		false,
		"an in-flight attempt cannot be replaced",
	);
	assert.equal(
		journal.markCommitted(ready.id, 200, "legacy-session"),
		false,
		"the legacy direct transition cannot bypass a durable attempt",
	);
	assert.equal(
		journal.markCommittedFromAttempt(
			ready.id,
			"stale-attempt",
			200,
			"commit-session-a",
		),
		false,
		"a stale continuation cannot commit a newer attempt",
	);
	assert.equal(
		journal.markCommittedFromAttempt(
			ready.id,
			ATTEMPT_ID,
			200,
			"commit-session-a",
			"candidate-a",
			"delete-episode-a",
		),
		true,
	);
	assert.deepEqual(onlyEntry(journal), {
		...ready,
		committedAt: 200,
		commitSessionId: "commit-session-a",
		receiptCandidateId: "candidate-a",
		commitDeleteFingerprint: "delete-episode-a",
	});
	assert.equal(
		journal.clearCommitAttempt(ready.id, ATTEMPT_ID),
		false,
		"a committed record cannot be returned to ready state",
	);
}

console.log("\n--- Pending blob intent write-ahead: exact attempt clear ---");
{
	const journal = readyDelete();
	const ready = onlyEntry(journal);
	markOnlyEntryAttempted(journal);
	assert.equal(journal.clearCommitAttempt(ready.id, "stale-attempt"), false);
	assert.equal(journal.clearCommitAttempt(ready.id, ATTEMPT_ID), true);
	assert.deepEqual(onlyEntry(journal), ready);
	assert.equal(
		journal.markCommitAttempted(ready.id, "attempt-b", 175, "attempt-session-b"),
		true,
		"a known-no-mutation attempt can be retried only after its exact clear",
	);
}

console.log("\n--- Pending blob intent write-ahead: strict persisted state invariants ---");
{
	const base = onlyEntry(readyDelete());
	const malformed: unknown[] = [
		{ ...base, commitAttemptId: ATTEMPT_ID },
		{ ...base, attemptedAt: 150 },
		{ ...base, attemptSessionId: ATTEMPT_SESSION_ID },
		{ ...base, commitAttemptId: "", attemptedAt: 150, attemptSessionId: ATTEMPT_SESSION_ID },
		{ ...base, commitAttemptId: ATTEMPT_ID, attemptedAt: -1, attemptSessionId: ATTEMPT_SESSION_ID },
		{ ...base, commitAttemptId: ATTEMPT_ID, attemptedAt: 1.5, attemptSessionId: ATTEMPT_SESSION_ID },
		{ ...base, commitAttemptId: ATTEMPT_ID, attemptedAt: 150, attemptSessionId: "" },
		{
			...base,
			commitAttemptId: ATTEMPT_ID,
			attemptedAt: 150,
			attemptSessionId: ATTEMPT_SESSION_ID,
			committedAt: 200,
			commitSessionId: "commit-session-a",
		},
		{
			...base,
			commitAttemptId: ATTEMPT_ID,
			attemptedAt: 150,
			attemptSessionId: ATTEMPT_SESSION_ID,
			receiptCandidateId: "candidate-a",
		},
		{ ...base, committedAt: 200 },
		{ ...base, commitSessionId: "commit-session-a" },
		{ ...base, committedAt: 200, commitSessionId: "" },
	];
	for (const candidate of malformed) {
		assert.equal(
			new PendingBlobIntentJournal([candidate]).size,
			0,
			`malformed state must be rejected: ${JSON.stringify(candidate)}`,
		);
	}

	const attempted = {
		...base,
		commitAttemptId: ATTEMPT_ID,
		attemptedAt: 150,
		attemptSessionId: ATTEMPT_SESSION_ID,
	};
	assert.deepEqual(
		jsonClone(new PendingBlobIntentJournal([attempted]).getEntries(SCOPE)),
		jsonClone([attempted]),
		"a complete attempted state is accepted without normalization into ready",
	);
}

console.log("\n--- Pending blob intent write-ahead: attempted entries never coalesce or rewrite ---");
{
	const duplicateDelete = readyDelete();
	const attemptedDelete = markOnlyEntryAttempted(duplicateDelete);
	const nextDelete = duplicateDelete.recordDelete(
		"assets/a.png",
		SCOPE,
		{ known: true, ref: REF_H2 },
		200,
	);
	assert.notEqual(nextDelete.id, attemptedDelete.id);
	assert.equal(duplicateDelete.size, 2, "duplicate delete creates a separate ready episode");
	assert.equal(
		pendingBlobIntentsOverlap(attemptedDelete, nextDelete),
		true,
		"a later same-path ready delete overlaps and cannot bypass its attempted fence",
	);

	const deleteThenRename = readyDelete();
	const fencedDelete = markOnlyEntryAttempted(deleteThenRename);
	const renameAfterDelete = deleteThenRename.recordRename(
		"assets/a.png",
		"assets/b.png",
		SCOPE,
		{ known: true, ref: REF_H2 },
		200,
	);
	assert.ok(renameAfterDelete);
	assert.notEqual(renameAfterDelete.id, fencedDelete.id);
	assert.equal(deleteThenRename.size, 2, "attempted delete does not suppress a new rename");

	const renameThenDestinationDelete = readyRename();
	const fencedRename = markOnlyEntryAttempted(renameThenDestinationDelete);
	const destinationDelete = renameThenDestinationDelete.recordDelete(
		"assets/b.png",
		SCOPE,
		{ known: true, ref: REF_H2 },
		200,
	);
	assert.equal(destinationDelete.kind, "delete");
	assert.equal(destinationDelete.path, "assets/b.png");
	assert.equal(renameThenDestinationDelete.size, 2);
	assert.equal(
		pendingBlobIntentsOverlap(fencedRename, destinationDelete),
		true,
		"an attempted rename owns its destination against a later ready delete",
	);
	assert.deepEqual(
		renameThenDestinationDelete.getEntries(SCOPE).find((entry) => entry.id === fencedRename.id),
		fencedRename,
		"destination delete cannot collapse or remove the attempted source rename",
	);

	const renameThenSourceDelete = readyRename();
	const sourceFencedRename = markOnlyEntryAttempted(renameThenSourceDelete);
	const sourceDelete = renameThenSourceDelete.recordDelete(
		"assets/a.png",
		SCOPE,
		{ known: true, ref: REF_H2 },
		200,
	);
	assert.equal(sourceDelete.kind, "delete");
	assert.equal(sourceDelete.path, "assets/a.png");
	assert.equal(renameThenSourceDelete.size, 2);
	assert.equal(
		pendingBlobIntentsOverlap(sourceFencedRename, sourceDelete),
		true,
		"an attempted rename owns its source against a later ready delete",
	);
	assert.deepEqual(
		renameThenSourceDelete.getEntries(SCOPE).find((entry) => entry.id === sourceFencedRename.id),
		sourceFencedRename,
		"source delete cannot filter out an attempted rename",
	);

	const chainedRename = readyRename();
	const chainedFence = markOnlyEntryAttempted(chainedRename);
	const nextChainedRename = chainedRename.recordRename(
		"assets/b.png",
		"assets/c.png",
		SCOPE,
		{ known: true, ref: REF_H2 },
		200,
	);
	assert.ok(nextChainedRename);
	assert.notEqual(nextChainedRename.id, chainedFence.id);
	assert.deepEqual(
		chainedRename.getEntries(SCOPE).find((entry) => entry.id === chainedFence.id),
		chainedFence,
		"a new rename cannot extend an attempted rename chain",
	);

	const sameSourceRename = readyRename();
	const sameSourceFence = markOnlyEntryAttempted(sameSourceRename);
	const replacementRename = sameSourceRename.recordRename(
		"assets/a.png",
		"assets/c.png",
		SCOPE,
		{ known: true, ref: REF_H2 },
		200,
	);
	assert.ok(replacementRename);
	assert.notEqual(replacementRename.id, sameSourceFence.id);
	assert.deepEqual(
		sameSourceRename.getEntries(SCOPE).find((entry) => entry.id === sameSourceFence.id),
		sameSourceFence,
		"a same-source rename cannot rewrite an attempted destination",
	);
}

console.log("\n--- Pending blob intent write-ahead: crash rehydrate and defensive copies ---");
{
	const beforeCrash = readyDelete();
	const attempted = markOnlyEntryAttempted(beforeCrash);
	const persisted = jsonClone(beforeCrash.getEntries(SCOPE));
	const afterCrash = new PendingBlobIntentJournal(persisted);

	assert.deepEqual(
		jsonClone(afterCrash.getEntries(SCOPE)),
		persisted,
		"an attempted fence survives a durable crash/rehydrate boundary",
	);
	assert.equal(
		afterCrash.markCommitAttempted(attempted.id, "replacement-attempt", 200, "replacement-session"),
		false,
		"restart cannot reinterpret an attempted record as ready",
	);
	assert.equal(
		afterCrash.markCommitted(attempted.id, 200, "legacy-session"),
		false,
		"restart cannot bypass write-ahead through the legacy transition",
	);

	const exposed = afterCrash.getEntries(SCOPE)[0]!;
	exposed.scope.host = "https://mutated.example.test";
	exposed.commitAttemptId = "mutated-attempt";
	if (exposed.expectedSourceRef) exposed.expectedSourceRef.hash = REF_H2.hash;
	persisted[0]!.scope.vaultId = "mutated-vault";
	persisted[0]!.commitAttemptId = "mutated-persisted-attempt";
	if (persisted[0]!.expectedSourceRef) persisted[0]!.expectedSourceRef.hash = REF_H2.hash;

	const unchanged = onlyEntry(afterCrash);
	assert.equal(unchanged.scope.host, SCOPE.host);
	assert.equal(unchanged.scope.vaultId, SCOPE.vaultId);
	assert.equal(unchanged.commitAttemptId, ATTEMPT_ID);
	assert.equal(unchanged.expectedSourceRef?.hash, REF_H1.hash);
	assert.equal(
		afterCrash.markCommittedFromAttempt(
			attempted.id,
			ATTEMPT_ID,
			250,
			"commit-session-after-crash",
		),
		true,
		"only the exact rehydrated attempt token can advance after restart",
	);
}

console.log("Pending blob intent write-ahead tests passed.");
