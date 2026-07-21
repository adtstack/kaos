import { readFileSync } from "node:fs";
import {
	migratePendingBlobIntentDocumentOwnership,
	PendingBlobIntentJournal,
	type PendingBlobIntent,
	type PendingBlobIntentScope,
	type PendingBlobMutationBase,
} from "../src/sync/pendingBlobIntentJournal";
import type { BlobRef } from "../src/types";
import {
	createPersistedBlobQueueSnapshot,
	readPersistedBlobQueueSnapshot,
} from "../src/sync/persistedBlobQueue";
import type { BlobQueueSnapshot } from "../src/sync/blobSync";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${message}`);
	failed++;
}

function sameValue(actual: unknown, expected: unknown): boolean {
	if (expected !== null && typeof expected === "object") {
		return JSON.stringify(actual) === JSON.stringify(expected);
	}
	return actual === expected;
}

function sameEntries(
	actual: PendingBlobIntent[],
	expected: Array<Record<string, unknown>>,
): boolean {
	return actual.length === expected.length && actual.every((entry, index) => {
		const expectedEntry = expected[index];
		return expectedEntry !== undefined
			&& Object.entries(expectedEntry).every(
				([key, value]) => sameValue(
					(entry as unknown as Record<string, unknown>)[key],
					value,
				),
			);
	});
}

const SCOPE_A: PendingBlobIntentScope = {
	host: "https://sync.example.test",
	vaultId: "vault-a",
	localDeviceId: "local-device-a",
};
const SCOPE_B: PendingBlobIntentScope = {
	...SCOPE_A,
	localDeviceId: "local-device-b",
};
const REF_H1: BlobRef = { hash: "a".repeat(64), size: 17 };
const REF_H2: BlobRef = { hash: "b".repeat(64), size: 23 };
const BASE_H1: PendingBlobMutationBase = {
	known: true,
	ref: REF_H1,
	sourceVersionKnown: true,
	expectedSourceVersion: "1:1",
};
const BASE_H2: PendingBlobMutationBase = {
	known: true,
	ref: REF_H2,
	sourceVersionKnown: true,
	expectedSourceVersion: "2:2",
};
const BASE_ABSENT: PendingBlobMutationBase = {
	known: true,
	ref: undefined,
	sourceVersionKnown: true,
};
const DELETE_FINGERPRINT_H1 = "delete-episode-h1";

console.log("\n--- Blob ownership migration: old Base and safety-subtree intents cannot replay ---");
{
	const deleteBase = new PendingBlobIntentJournal()
		.recordDelete("BACKLOG/BACKLOG.base", SCOPE_A, BASE_H1, 1);
	assert(
		migratePendingBlobIntentDocumentOwnership(deleteBase) === null,
		"legacy Base delete intent is dropped",
	);

	const baseToBlob = new PendingBlobIntentJournal()
		.recordRename("BACKLOG/BACKLOG.base", "assets/export.png", SCOPE_A, BASE_H1, 2)!;
	assert(
		migratePendingBlobIntentDocumentOwnership(baseToBlob) === null,
		"legacy Base source rename is dropped and cannot tombstone document authority",
	);

	const blobToBase = new PendingBlobIntentJournal()
		.recordRename("assets/old.png", "BACKLOG/BACKLOG.base", SCOPE_A, BASE_H1, 3)!;
	const migratedBlobToBase = migratePendingBlobIntentDocumentOwnership(blobToBase);
	assert(
		migratedBlobToBase?.kind === "delete"
			&& migratedBlobToBase.path === "assets/old.png"
			&& migratedBlobToBase.id === blobToBase.id,
		"blob→Base rename keeps only the old blob source deletion",
	);

	const blobToBlob = new PendingBlobIntentJournal()
		.recordRename("assets/a.png", "assets/b.png", SCOPE_A, BASE_H1, 4)!;
	assert(
		migratePendingBlobIntentDocumentOwnership(blobToBlob) === blobToBlob,
		"blob→blob intent remains unchanged",
	);

	const safetyDir =
		"BACKLOG (KAOS local backup 2026-07-17T08-00-00Z 0123456789abcdef)";
	const incidentRename = new PendingBlobIntentJournal()
		.recordRename(
			"BACKLOG/image.png",
			`${safetyDir}/image.png`,
			SCOPE_A,
			BASE_H1,
			5,
		)!;
	assert(
		migratePendingBlobIntentDocumentOwnership(incidentRename) === null,
		"incident-shaped rename into a local-backup subtree is dropped instead of tombstoning the source",
	);

	const safetyDelete = new PendingBlobIntentJournal()
		.recordDelete(`${safetyDir}/nested/icon.png`, SCOPE_A, BASE_H1, 6);
	assert(
		migratePendingBlobIntentDocumentOwnership(safetyDelete) === null,
		"legacy delete inside a local-backup subtree is dropped",
	);
}

console.log("\n--- Persisted blob queue: exact local authority scope ---");
{
	const queue: BlobQueueSnapshot = {
		uploads: [{
			path: "assets/local.png",
			baseRefKnown: true,
			expectedBaseRef: REF_H1,
			expectedBaseSourceVersion: "1:1",
			retries: 1,
			status: "processing",
			readyAt: 100,
		}],
		downloads: [{
			path: "assets/remote.png",
			hash: REF_H2.hash,
			sizeBytes: REF_H2.size,
			acceptableLocalHashes: [REF_H1.hash],
		}],
	};
	const persisted = createPersistedBlobQueueSnapshot(queue, SCOPE_A);
	assert(
		JSON.stringify(readPersistedBlobQueueSnapshot(persisted, SCOPE_A))
			=== JSON.stringify(queue),
		"same-scope queue survives a defensive durable round trip",
	);
	assert(
		[
			SCOPE_B,
			{ ...SCOPE_A, host: "https://other.example.test" },
			{ ...SCOPE_A, vaultId: "vault-b" },
		].every((scope) => readPersistedBlobQueueSnapshot(persisted, scope) === null),
		"foreign host, vault, or device queues are never hydrated",
	);
	assert(
		readPersistedBlobQueueSnapshot(queue, SCOPE_A) === null,
		"legacy unscoped queue is never hydrated",
	);
	assert(
		readPersistedBlobQueueSnapshot({
			...persisted,
			queue: { uploads: [{ path: "assets/local.png", retries: -1 }], downloads: [] },
		}, SCOPE_A) === null,
		"malformed same-scope queue fails closed",
	);
	let missingScopeRejected = false;
	try {
		createPersistedBlobQueueSnapshot(queue, { ...SCOPE_A, localDeviceId: "" });
	} catch {
		missingScopeRejected = true;
	}
	assert(missingScopeRejected, "a queue cannot be persisted without full local scope");
}

console.log("\n--- Pending blob intent journal: causal rename chains ---");
{
	const journal = new PendingBlobIntentJournal();
	const first = journal.recordRename(
		"assets/a.png",
		"assets/b.png",
		SCOPE_A,
		BASE_H1,
		100,
	);
	const chained = journal.recordRename(
		"assets/b.png",
		"assets/c.png",
		SCOPE_A,
		BASE_H2,
		200,
	);
	const entries = journal.getEntries(SCOPE_A);

	assert(first !== null, "first startup rename is recorded");
	assert(chained?.id === first?.id, "a chained rename retains one durable intent identity");
	assert(
		sameEntries(entries, [{
			kind: "rename",
			oldPath: "assets/a.png",
			newPath: "assets/c.png",
			recordedAt: 200,
			scope: SCOPE_A,
			baseRefKnown: true,
			expectedSourceRef: REF_H1,
		}]),
		"A -> B -> C keeps A's original CAS base while coalescing to A -> C",
	);
}

console.log("\n--- Pending blob intent journal: rename followed by delete ---");
{
	const journal = new PendingBlobIntentJournal();
	journal.recordRename("assets/a.png", "assets/b.png", SCOPE_A, BASE_H1, 100);
	journal.recordRename("assets/b.png", "assets/c.png", SCOPE_A, BASE_H2, 200);
	journal.recordDelete("assets/c.png", SCOPE_A, BASE_H2, 300);

	assert(
		sameEntries(journal.getEntries(SCOPE_A), [{
			kind: "delete",
			path: "assets/a.png",
			recordedAt: 300,
			baseRefKnown: true,
			expectedSourceRef: REF_H1,
		}]),
		"A -> B -> C followed by deleting C collapses to deletion of source A with A's CAS base",
	);
}

console.log("\n--- Pending blob intent journal: inverse and duplicate operations ---");
{
	const journal = new PendingBlobIntentJournal();
	journal.recordRename("assets/a.png", "assets/b.png", SCOPE_A, BASE_H1, 100);
	const inverse = journal.recordRename(
		"assets/b.png",
		"assets/a.png",
		SCOPE_A,
		BASE_H2,
		200,
	);
	assert(inverse === null && journal.size === 0, "A -> B -> A cancels the pending rename");

	const firstDelete = journal.recordDelete("assets/a.png", SCOPE_A, BASE_H1, 300);
	const duplicateDelete = journal.recordDelete("assets/a.png", SCOPE_A, BASE_H2, 400);
	assert(firstDelete.id === duplicateDelete.id, "duplicate pending delete reuses its durable identity");
	assert(journal.size === 1, "duplicate pending delete does not amplify the journal");
	assert(
		journal.recordRename("assets/a.png", "assets/b.png", SCOPE_A, BASE_H1, 500) === null,
		"a pending delete already owning the source is not weakened into a rename",
	);
	assert(
		sameEntries(journal.getEntries(SCOPE_A), [{ expectedSourceRef: REF_H1 }]),
		"duplicate observation cannot replace the original delete CAS base",
	);
}

console.log("\n--- Pending blob intent journal: committed episodes are immutable ---");
{
	const journal = new PendingBlobIntentJournal();
	const committedRename = journal.recordRename(
		"assets/a.png",
		"assets/b.png",
		SCOPE_A,
		BASE_H1,
		100,
	);
	assert(committedRename !== null, "rename episode exists before commit");
	assert(
		journal.markCommitted(
			committedRename!.id,
			150,
			"session-a",
			"candidate-a",
			DELETE_FINGERPRINT_H1,
		),
		"pending rename advances to committed/unconfirmed exactly once",
	);
	assert(
		!journal.markCommitted(
			committedRename!.id,
			160,
			"session-b",
			"candidate-b",
			"different-delete-episode",
		),
		"a committed episode cannot have its receipt identity rewritten",
	);
	const nextRename = journal.recordRename(
		"assets/b.png",
		"assets/c.png",
		SCOPE_A,
		BASE_H2,
		200,
	);
	assert(
		nextRename !== null && nextRename.id !== committedRename!.id,
		"committed A -> B followed by B -> C creates a separate B-based episode",
	);
	assert(
		sameEntries(journal.getEntries(SCOPE_A), [
			{
				id: committedRename!.id,
				oldPath: "assets/a.png",
				newPath: "assets/b.png",
				committedAt: 150,
				commitSessionId: "session-a",
				receiptCandidateId: "candidate-a",
				commitDeleteFingerprint: DELETE_FINGERPRINT_H1,
				expectedSourceRef: REF_H1,
			},
			{
				id: nextRename!.id,
				oldPath: "assets/b.png",
				newPath: "assets/c.png",
				committedAt: undefined,
				expectedSourceRef: REF_H2,
			},
		]),
		"the committed rename and subsequent pending rename retain independent causal bases",
	);

	const committedDelete = journal.recordDelete(
		"assets/delete.png",
		SCOPE_A,
		BASE_H1,
		300,
	);
	journal.markCommitted(committedDelete.id, 350, "session-a", "candidate-delete");
	const nextDelete = journal.recordDelete(
		"assets/delete.png",
		SCOPE_A,
		BASE_H2,
		400,
	);
	assert(
		nextDelete.id !== committedDelete.id,
		"a new same-path delete never coalesces into a committed delete episode",
	);
	assert(
		journal.getEntries(SCOPE_A).find((entry) => entry.id === committedDelete.id)?.committedAt === 350,
		"the first delete receipt metadata remains immutable after a later delete",
	);
}

console.log("\n--- Pending blob intent journal: committed rename plus destination delete ---");
{
	const journal = new PendingBlobIntentJournal();
	const rename = journal.recordRename("assets/a.png", "assets/b.png", SCOPE_A, BASE_H1, 100);
	journal.markCommitted(rename!.id, 150, "session-a", "candidate-a");
	const deleteB = journal.recordDelete("assets/b.png", SCOPE_A, BASE_H2, 200);
	const entries = journal.getEntries(SCOPE_A);
	assert(entries.length === 2, "committed A -> B plus delete B retains two ordered episodes");
	assert(
		deleteB.kind === "delete"
			&& deleteB.path === "assets/b.png"
			&& deleteB.baseRefKnown
			&& sameValue(deleteB.expectedSourceRef, REF_H2),
		"the later B delete is based on B authority, not rewritten as deletion of A",
	);
	assert(journal.hasPath("assets/a.png", SCOPE_A), "committed rename continues blocking its old path");
	assert(
		journal.hasPath("assets/b.png", SCOPE_A),
		"the independent pending B delete blocks B while awaiting its own commit",
	);
}

console.log("\n--- Pending blob intent journal: scope isolation ---");
{
	const journal = new PendingBlobIntentJournal();
	const local = journal.recordDelete("assets/a.png", SCOPE_A, BASE_H1, 100);
	const foreign = journal.recordDelete("assets/a.png", SCOPE_B, BASE_H2, 200);
	assert(local.id !== foreign.id, "same-path operations from different local devices never coalesce");
	assert(journal.getEntries(SCOPE_A).length === 1, "scope A reads only its own intent");
	assert(journal.getEntries(SCOPE_B).length === 1, "scope B reads only its own intent");
	assert(
		journal.hasPath("assets/a.png", SCOPE_A) && journal.hasPath("assets/a.png", SCOPE_B),
		"path blocking is evaluated independently in each active scope",
	);
	journal.remove(local.id);
	assert(
		journal.getEntries(SCOPE_A).length === 0 && journal.getEntries(SCOPE_B)[0]?.id === foreign.id,
		"acknowledging one device's intent preserves the foreign-device entry",
	);
}

console.log("\n--- Pending blob intent journal: hydrate, snapshots, and acknowledgement ---");
{
	const validDelete: PendingBlobIntent = {
		id: "delete-1",
		kind: "delete",
		path: "assets/a.png",
		recordedAt: 100,
		scope: SCOPE_A,
		baseRefKnown: true,
		sourceVersionKnown: true,
	};
	const validRename: PendingBlobIntent = {
		id: "rename-1",
		kind: "rename",
		oldPath: "assets/b.png",
		newPath: "assets/c.png",
		recordedAt: 200,
		scope: SCOPE_A,
		baseRefKnown: true,
		expectedSourceRef: REF_H1,
		sourceVersionKnown: true,
		expectedSourceVersion: "1:1",
		committedAt: 250,
		commitSessionId: "previous-session",
		receiptCandidateId: "candidate-1",
		commitDeleteFingerprint: DELETE_FINGERPRINT_H1,
	};
	const journal = new PendingBlobIntentJournal([
		validDelete,
		{ ...validDelete, id: "bad-path", path: 42 },
		{ ...validDelete, id: "bad-scope", scope: { ...SCOPE_A, localDeviceId: "" } },
		{ ...validDelete, id: "bad-ref", expectedSourceRef: { hash: "bad", size: 1 } },
		{
			...validDelete,
			id: "bad-ref-duplicate-lineage",
			expectedSourceRef: {
				...REF_H1,
				priorHashes: [REF_H2.hash, REF_H2.hash],
			},
		},
		{
			...validDelete,
			id: "bad-ref-self-lineage",
			expectedSourceRef: {
				...REF_H1,
				priorHashes: [REF_H1.hash],
			},
		},
		{
			...validDelete,
			id: "bad-ref-oversized-lineage",
			expectedSourceRef: {
				...REF_H1,
				priorHashes: Array.from(
					{ length: 17 },
					(_, index) => (index + 1).toString(16).padStart(64, "0"),
				),
			},
		},
		{
			...validDelete,
			id: "bad-ref-fractional-size",
			expectedSourceRef: { ...REF_H1, size: 1.5 },
		},
		{
			...validRename,
			id: "bad-commit-fingerprint",
			commitDeleteFingerprint: "",
		},
		{
			...validRename,
			id: "bad-source-version",
			expectedSourceVersion: "not-a-yjs-item-id",
		},
		{
			...validRename,
			id: "missing-source-version",
			expectedSourceVersion: undefined,
		},
		{
			...validRename,
			id: "untrusted-source-version",
			sourceVersionKnown: false,
		},
		{
			...validDelete,
			id: "bad-uncommitted-fingerprint",
			commitDeleteFingerprint: DELETE_FINGERPRINT_H1,
		},
		{
			...validDelete,
			id: "bad-committed-without-session",
			committedAt: 300,
			commitDeleteFingerprint: DELETE_FINGERPRINT_H1,
		},
		{
			...validRename,
			id: "same",
			oldPath: "x",
			newPath: "x",
		},
		validRename,
	]);

	assert(
		journal.size === 2,
		"hydrate rejects malformed paths, scopes, strict refs, commit metadata, and same-path entries",
	);
	const snapshot = journal.getEntries(SCOPE_A);
	(snapshot[0] as Extract<PendingBlobIntent, { kind: "delete" }>).path = "mutated.png";
	snapshot[0]!.scope.localDeviceId = "mutated-device";
	if (snapshot[1]?.expectedSourceRef) snapshot[1].expectedSourceRef.hash = "c".repeat(64);
	const fresh = journal.getEntries(SCOPE_A);
	assert(
		(fresh[0] as Extract<PendingBlobIntent, { kind: "delete" }>).path === "assets/a.png"
			&& fresh[0]?.scope.localDeviceId === SCOPE_A.localDeviceId
			&& fresh[1]?.expectedSourceRef?.hash === REF_H1.hash,
		"getEntries returns defensive path, scope, and BlobRef snapshots",
	);
	assert(journal.remove("missing") === false, "failed acknowledgement keeps all entries");
	assert(journal.remove("delete-1") === true, "successful acknowledgement removes one exact intent");
	assert(
		sameEntries(journal.getEntries(SCOPE_A), [{
			id: "rename-1",
			oldPath: "assets/b.png",
			newPath: "assets/c.png",
				committedAt: 250,
				receiptCandidateId: "candidate-1",
				commitDeleteFingerprint: DELETE_FINGERPRINT_H1,
			}]),
		"acknowledgement never removes an unrelated committed intent",
	);
}

console.log("\n--- Pending blob intent journal: no silent capacity loss ---");
{
	const journal = new PendingBlobIntentJournal();
	for (let index = 0; index < 1025; index++) {
		journal.recordDelete(`assets/${index}.bin`, SCOPE_A, BASE_ABSENT, index);
	}
	const entries = journal.getEntries(SCOPE_A);
	assert(entries.length === 1025, "every distinct user intent remains durable past 1024 entries");
	assert(
		entries[0]?.kind === "delete" && entries[0].path === "assets/0.bin",
		"the oldest pending delete is never silently evicted",
	);
	assert(
		entries.at(-1)?.kind === "delete" && entries.at(-1)?.path === "assets/1024.bin",
		"the newest pending delete is retained alongside prior intents",
	);
}

console.log("\n--- main.ts startup, CAS, and receipt wiring ---");
{
	const main = readFileSync("src/main.ts", "utf8");
	const renameStart = main.indexOf('this.app.vault.on("rename"');
	const renameEnd = main.indexOf('this.app.vault.on("delete"', renameStart);
	const renameHandler = main.slice(renameStart, renameEnd);
	const deleteStart = renameEnd;
	const deleteEnd = main.indexOf('this.app.vault.on("create"', deleteStart);
	const deleteHandler = main.slice(deleteStart, deleteEnd);
	const recordDeleteStart = main.indexOf("private recordPendingBlobDelete(");
	const recordDeleteEnd = main.indexOf("private recordPendingBlobRename(", recordDeleteStart);
	const recordDelete = main.slice(recordDeleteStart, recordDeleteEnd);
	const recordRenameStart = recordDeleteEnd;
	const recordRenameEnd = main.indexOf("private prunePendingBlobRenameFiles(", recordRenameStart);
	const recordRename = main.slice(recordRenameStart, recordRenameEnd);
	assert(
		recordDelete.indexOf("captureBlobMutationBase(path)") >= 0
			&& recordDelete.indexOf("fenceLocalMutationIntent(path, reason)")
				< recordDelete.indexOf("pendingBlobIntents.recordDelete")
			&& recordDelete.indexOf("pendingBlobIntents.recordDelete")
				< recordDelete.indexOf("persistPendingBlobIntents"),
		"delete captures its CAS base, fences transfers, then schedules durable persistence",
	);
	assert(
		recordRename.includes("captureBlobMutationBase(oldPath)")
			&& recordRename.includes("fenceLocalMutationIntent(oldPath, reason)")
			&& recordRename.includes("entry.commitAttemptId === undefined")
			&& recordRename.indexOf("pendingBlobIntents.recordRename")
				< recordRename.indexOf("persistPendingBlobIntents"),
		"rename captures source authority and never rewrites an attempted episode before persistence",
	);

	const renameStartupGate = renameHandler.indexOf("!this.reconciliationController.isReconciled");
	const renameAttachmentEnabled = renameHandler.indexOf(
		"this.getRuntimeConfig().enableAttachmentSync",
		renameStartupGate,
	);
	const renameIntentRecord = renameHandler.indexOf("recordPendingBlobRename");
	assert(renameStart >= 0 && renameEnd > renameStart, "blob rename vault handler is located");
	assert(
		renameIntentRecord >= 0 && renameIntentRecord < renameHandler.indexOf("return;", renameStartupGate),
		"pre-reconcile blob rename is journaled before the startup early return",
	);
	assert(
		renameAttachmentEnabled > renameStartupGate && renameAttachmentEnabled < renameIntentRecord,
		"pre-reconcile blob rename is not journaled when attachment sync is disabled",
	);

	const deleteStartupGate = deleteHandler.indexOf("!this.reconciliationController.isReconciled");
	const deleteAttachmentEnabled = deleteHandler.indexOf(
		"this.getRuntimeConfig().enableAttachmentSync",
		deleteStartupGate,
	);
	const deleteIntentRecord = deleteHandler.indexOf("recordPendingBlobDelete");
	assert(deleteStart >= 0 && deleteEnd > deleteStart, "blob delete vault handler is located");
	assert(
		deleteIntentRecord >= 0 && deleteIntentRecord < deleteHandler.indexOf("return;", deleteStartupGate),
		"pre-reconcile blob delete is journaled before the startup early return",
	);
	assert(
		deleteAttachmentEnabled > deleteStartupGate && deleteAttachmentEnabled < deleteIntentRecord,
		"pre-reconcile blob delete is not journaled when attachment sync is disabled",
	);

	const reconciliation = readFileSync("src/runtime/reconciliationController.ts", "utf8");
	const reconcileReplay = reconciliation.indexOf("await this.deps.replayPendingBlobIntents?.(");
	const blobReconcile = reconciliation.indexOf("blobSync.reconcile(", reconcileReplay);
	assert(
		reconcileReplay >= 0 && blobReconcile > reconcileReplay,
		"reconciliation awaits pending intent replay before stale blob downloads can be queued",
	);
	const orchestrator = readFileSync("src/runtime/attachmentOrchestrator.ts", "utf8");
	const blobSyncSource = readFileSync("src/sync/blobSync.ts", "utf8");
	const engineReplay = orchestrator.indexOf("await this.deps.replayPendingBlobIntents(");
	const engineReconcile = orchestrator.indexOf('blobSync.reconcile("authoritative"', engineReplay);
	assert(
		engineReplay >= 0 && engineReconcile > engineReplay,
		"a late-created attachment manager awaits intent replay before initial reconciliation",
	);

	const replayWrapperStart = main.indexOf("private replayPendingBlobIntents(reason: string)");
	const replayOnceStart = main.indexOf("private async replayPendingBlobIntentsOnce(");
	const replayEnd = main.indexOf("\n\tprivate async openDashboard(", replayOnceStart);
	const replayWrapper = main.slice(replayWrapperStart, replayOnceStart);
	const replay = main.slice(replayOnceStart, replayEnd);
	assert(
		replayWrapperStart >= 0
			&& replayOnceStart > replayWrapperStart
			&& replayWrapper.includes("pendingBlobIntentReplayChain")
			&& replayWrapper.includes("replayPendingBlobIntentsOnce(reason)"),
		"replay is serialized through one wrapper before entering the one-shot implementation",
	);
	const replayEntries = replay.indexOf("pendingBlobIntents.getEntries(scope)");
	const flushIntents = replay.indexOf("flushPendingBlobIntentPersistence()");
	const flushSettled = replay.indexOf("flushBlobSettledRefPersistence()");
	const firstApply = replay.indexOf("this.applyPendingBlobDelete(");
	const documentMigration = replay.indexOf("migratePendingBlobIntentDocumentOwnership(intent)");
	const migrationPersist = replay.indexOf("await this.enqueuePendingBlobIntentPersistence()", documentMigration);
	const migrationFlush = replay.indexOf("await this.flushPendingBlobIntentPersistence()", migrationPersist);
	assert(
		replay.includes("!this.getRuntimeConfig().enableAttachmentSync")
			&& replay.includes("vaultSync?.providerSynced")
			&& replayEntries >= 0,
		"replay requires enabled attachment sync, provider authority, and active-scope entries",
	);
	assert(
		flushIntents >= 0 && flushSettled > flushIntents && firstApply > flushSettled,
		"replay flushes both durable local journals before applying any CRDT mutation",
	);
	assert(
		documentMigration >= 0
			&& migrationPersist > documentMigration
			&& migrationFlush > migrationPersist
			&& firstApply > migrationFlush,
		"document-owned blob intents are migrated and durably flushed before any blob CAS",
	);
	assert(
		replay.includes("getAbstractFileByPath(intent.path)")
			&& replay.includes("getAbstractFileByPath(intent.oldPath)")
			&& replay.includes("getAbstractFileByPath(intent.newPath)"),
		"replay rechecks delete and rename disk postconditions before CAS application",
	);
	const commitStart = main.indexOf("private commitReadyPendingBlobIntent(");
	const commitEnd = main.indexOf("private async finishPendingBlobIntentCommit(", commitStart);
	const commit = main.slice(commitStart, commitEnd);
	const commitCoordinator = readFileSync("src/sync/pendingBlobIntentCommit.ts", "utf8");
	assert(
		replay.includes("isPendingBlobIntentReceiptConfirmed(intent, vaultSync)")
			&& replay.includes("commitReadyPendingBlobIntent(")
			&& commit.includes("pendingBlobIntents.markCommitAttempted(")
			&& commit.includes("pendingBlobIntents.markCommittedFromAttempt(")
			&& commitCoordinator.indexOf("hooks.markAttempted()")
				< commitCoordinator.indexOf("await hooks.persistAttempted()")
			&& commitCoordinator.indexOf("await hooks.persistAttempted()")
				< commitCoordinator.indexOf("hooks.apply()")
			&& commitCoordinator.indexOf("hooks.apply()")
				< commitCoordinator.indexOf("hooks.markCommitted(result)")
			&& commitCoordinator.indexOf("hooks.markCommitted(result)")
				< commitCoordinator.lastIndexOf("hooks.persistFinal()")
			&& commitCoordinator.lastIndexOf("hooks.persistFinal()")
				< commitCoordinator.lastIndexOf("hooks.flushReceipt()"),
		"every CAS has a durable write-ahead fence before apply and captures phase two before receipt flush",
	);

	const receiptStart = main.indexOf("private isPendingBlobIntentReceiptConfirmed(");
	const receiptEnd = main.indexOf("private hasPendingBlobIntentCommitPostcondition(", receiptStart);
	const receipt = main.slice(receiptStart, receiptEnd);
	const postconditionStart = receiptEnd;
	const postconditionEnd = main.indexOf("private recordCommittedBlobIntentConflict(", postconditionStart);
	const postcondition = main.slice(postconditionStart, postconditionEnd);
	assert(
		receipt.includes("vaultSync.serverAppliedLocalState !== true")
			&& receipt.includes("hasPendingBlobIntentCommitPostcondition(intent, vaultSync)")
			&& receipt.includes("vaultSync.lastConfirmedReceiptCandidateId === intent.receiptCandidateId")
			&& receipt.includes("vaultSync.lastServerReceiptEchoAt")
			&& receipt.includes("intent.committedAt"),
		"receipt confirmation requires server dominance plus exact candidate or later server echo",
	);
	assert(
		postcondition.includes("vaultSync.getBlobRef(sourcePath)")
			&& postcondition.includes("getAuthoritativeBlobDeleteSnapshot(sourcePath)")
			&& postcondition.includes("snapshot?.fingerprint === intent.commitDeleteFingerprint")
			&& postcondition.includes("sameBlobRef(snapshot.deletedRef, expectedRef)"),
		"receipt release revalidates source absence and the exact committed tombstone episode",
	);
	const deleteBranchEnd = replay.indexOf("\n\t\t\tconst oldOccupant");
	const deleteBranch = replay.slice(replay.indexOf('if (intent.kind === "delete")'), deleteBranchEnd);
	const renameBranch = replay.slice(deleteBranchEnd);
	const attemptedFence = replay.indexOf("if (intent.commitAttemptId !== undefined)");
	const firstIntentKind = replay.indexOf('if (intent.kind === "delete")');
	const firstOccupantRead = replay.indexOf("getAbstractFileByPath(intent.path)");
	assert(
		attemptedFence >= 0
			&& attemptedFence < firstIntentKind
			&& attemptedFence < firstOccupantRead
			&& replay.indexOf("hasOtherUnconfirmedBlobIntentFence(intent, scope)")
				< firstIntentKind
			&& commit.includes("hasOtherPendingBlobIntentOverlap(intent, scope)")
			&& deleteBranch.lastIndexOf("if (intent.committedAt !== undefined)")
				< deleteBranch.indexOf("const outcome = await this.commitReadyPendingBlobIntent")
			&& renameBranch.lastIndexOf("if (intent.committedAt !== undefined)")
				< renameBranch.indexOf("const outcome = await this.commitReadyPendingBlobIntent")
			&& !replay.includes("pendingBlobIntents.markCommitted(")
			&& !replay.includes("intent.commitSessionId"),
		"attempted and committed delete/rename episodes are fenced before occupant removal or CAS replay",
	);
	assert(
		commit.includes("commitDeleteFingerprint")
			&& commit.includes("getAuthoritativeBlobDeleteSnapshot(result.sourcePath)?.fingerprint")
			&& commit.includes("markCommittedFromAttempt("),
		"the first CRDT commit binds its durable journal entry to the exact tombstone episode",
	);
	assert(
		(replay.match(/getAbstractFileByPath\(intent\.path\)/g) ?? []).length >= 2
			&& (replay.match(/getAbstractFileByPath\(intent\.oldPath\)/g) ?? []).length >= 2
			&& replay.includes("The write-ahead await creates a real race window"),
		"delete and rename disk postconditions are re-read after write-ahead immediately before CAS",
	);

	const applyDeleteStart = main.indexOf("private applyPendingBlobDelete(");
	const applyRenameStart = main.indexOf("private applyPendingBlobRename(", applyDeleteStart);
	const applyEnd = main.indexOf("private isPendingBlobMutationConflict(", applyRenameStart);
	const applyDelete = main.slice(applyDeleteStart, applyRenameStart);
	const applyRename = main.slice(applyRenameStart, applyEnd);
	assert(
		applyDelete.includes("blobSync.handleFileDelete(intent.path")
			&& applyDelete.includes("vaultSync.deleteBlobRefIfCurrent(intent.path, base")
			&& !applyDelete.includes("vaultSync.deleteBlobRef(intent.path"),
		"delete replay uses the guarded CAS API in both manager and manager-null lanes",
	);
	assert(
		applyRename.includes("blobSync.handleFileRename(")
			&& applyRename.includes("vaultSync.renameBlobRefWithTombstoneIfCurrent(")
			&& !applyRename.includes("vaultSync.renameBlobRefWithTombstone("),
		"rename replay uses the guarded source-ref CAS API in both lanes",
	);
	assert(
		applyDelete.includes('result.kind === "unknown-source"')
			&& applyDelete.includes('result.kind === "source-conflict"')
			&& applyRename.includes('result.kind === "unknown-source"')
			&& applyRename.includes('result.kind === "source-conflict"'),
		"unknown or changed remote source authority is retained as durable Attention",
	);

	const ensureStoreStart = main.indexOf("private async ensurePendingBlobIntentPersistence(");
	const enqueueStoreStart = main.indexOf("private enqueuePendingBlobIntentPersistence(", ensureStoreStart);
	const persistStoreStart = main.indexOf("private persistPendingBlobIntents(", enqueueStoreStart);
	const storeWiring = main.slice(ensureStoreStart, persistStoreStart);
	assert(
		storeWiring.includes("buildPendingBlobIntentStoreKey(scope)")
			&& storeWiring.includes("new IndexedDbPendingBlobIntentStore(scope)")
			&& storeWiring.includes("pendingBlobIntents.getEntries(scope)"),
		"intent persistence is keyed and snapshotted by host, vault, and local device scope",
	);
	assert(
		storeWiring.includes("corruptPendingBlobIntentStoreKeys.has(key)")
			&& storeWiring.includes("corruptPendingBlobIntentStoreKeys.add(key)"),
		"a corrupt intent scope is latched across both ensure and enqueue attempts",
	);
	const ensureSettledStart = main.indexOf("private async ensureBlobSettledRefPersistence(");
	const enqueueSettledStart = main.indexOf("private enqueueBlobSettledRefPersistence(", ensureSettledStart);
	const ensureSettled = main.slice(ensureSettledStart, enqueueSettledStart);
	const enqueueSettledEnd = main.indexOf("private persistBlobSettledRefs(", enqueueSettledStart);
	const enqueueSettled = main.slice(enqueueSettledStart, enqueueSettledEnd);
	assert(
		ensureSettled.includes("corruptBlobSettledRefStoreKeys.has(key)")
			&& ensureSettled.includes("corruptBlobSettledRefStoreKeys.add(key)")
			&& !ensureSettled.includes("blobSettledRefStore.clear()")
			&& enqueueSettled.includes("corruptBlobSettledRefStoreKeys.has(key)"),
		"corrupt settlement authority is never auto-cleared or overwritten by a later enqueue",
	);
	assert(
		ensureSettled.includes("scrubBlobSettlementDocumentOwnership({")
			&& ensureSettled.includes("isPathBlobSyncable: (path) => this.isBlobPathSyncable(path)")
			&& ensureSettled.includes("|| ownership.changed")
			&& ensureSettled.indexOf("scrubBlobSettlementDocumentOwnership({")
				< ensureSettled.indexOf("Object.assign(this.blobSettledRefs, nextSettledRefs)"),
		"legacy Base and excluded safety-subtree settlement state is scrubbed and durably rewritten before attachment authority opens",
	);
	assert(
		ensureSettled.includes('stage.kind !== "manual-download-conflict"'),
		"a durable explicit Use-remote stage is not reclassified as generic legacy-missing Attention on restart",
	);
	const legacyAttentionStart = main.indexOf("private hydrateLegacyMissingBlobAttention(");
	const legacyAttentionEnd = main.indexOf("private persistBlobSettledRefs(", legacyAttentionStart);
	const legacyAttention = main.slice(legacyAttentionStart, legacyAttentionEnd);
	assert(
		legacyAttention.includes("entry.reason !== LEGACY_MISSING_BLOB_ATTENTION_REASON")
			&& legacyAttention.includes("this.isBlobPathSyncable(entry.path)")
			&& legacyAttention.includes("retainedBlobEntries.length !== previousBlobEntries.length"),
		"legacy attachment Attention is retired when a path moves to the Base document lane",
	);
	assert(
		main.includes("localDeviceId: this.blobIntentLocalDeviceId ?? \"\"")
			&& main.includes("this.pendingBlobIntents.hasPath(path, this.getBlobIntentScope())"),
		"runtime path blocking cannot consume a foreign device's journal entry",
	);
	const loadSettingsStart = main.indexOf("async loadSettings()");
	const saveSettingsStart = main.indexOf("async saveSettings(", loadSettingsStart);
	const loadSettings = main.slice(loadSettingsStart, saveSettingsStart);
	const persistQueueStart = main.indexOf("private async persistBlobQueueSnapshot(");
	const clearQueueStart = main.indexOf("private async clearSavedBlobQueue(", persistQueueStart);
	const persistQueue = main.slice(persistQueueStart, clearQueueStart);
	assert(
		loadSettings.includes("readPersistedBlobQueueSnapshot(")
			&& loadSettings.includes("this.getBlobIntentScope()")
			&& loadSettings.includes("delete this.persistedState._blobQueue")
			&& loadSettings.includes("migrated || scrubbedBlobQueue")
			&& persistQueue.includes("createPersistedBlobQueueSnapshot(")
			&& persistQueue.includes("scope: PendingBlobIntentScope")
			&& !persistQueue.includes("this.getBlobIntentScope()")
			&& persistQueue.includes("blobAuthorityScopeGuard.isCurrent(token, scope)")
			&& orchestrator.includes("blobQueuePersistenceScopes.set(blobSync")
			&& orchestrator.includes("authority.token"),
		"persisted transfer queues are exact-scoped and legacy/foreign queues are scrubbed",
	);
	const authorityCallbackStart = main.indexOf("onBlobReconciled: (mode, reconciledVaultSync) =>");
	const authorityCallbackEnd = main.indexOf("getAwaitingFirstProviderSyncAfterStartup", authorityCallbackStart);
	const authorityCallback = main.slice(authorityCallbackStart, authorityCallbackEnd);
	const authorityPredicateStart = main.indexOf("isUploadAuthoritySourceReady: (vaultSync, scope, token) =>");
	const authorityPredicateEnd = main.indexOf("onBlobSettledRefsChanged:", authorityPredicateStart);
	const authorityPredicate = main.slice(authorityPredicateStart, authorityPredicateEnd);
	const idbDegradedStart = main.indexOf("private handleIndexedDbDegraded(");
	const idbDegraded = main.slice(idbDegradedStart);
	assert(
		authorityCallback.includes("this.isVaultSyncBoundToCurrentBlobScope(reconciledVaultSync)")
			&& authorityCallback.includes("reconciledVaultSync.idbError !== true")
			&& authorityPredicate.includes("this.isBlobRuntimeAuthorityCurrent(vaultSync, scope, token)")
			&& authorityPredicate.includes("vaultSync.idbError !== true")
			&& idbDegraded.indexOf("this.blobLocalPersistenceReady = false")
				< idbDegraded.indexOf("if (this.idbDegradedHandled) return")
			&& main.includes("&& !vaultSync.idbError\n\t\t\t\t\t&& !this.blobLocalPersistenceReady"),
		"runtime IndexedDB degradation revokes and cannot later reopen attachment authority",
	);
	assert(
		main.includes("this.pendingBlobIntentStore.clear()")
			&& main.includes("this.blobSettledRefStore.clear()")
			&& main.includes("this.corruptPendingBlobIntentStoreKeys.delete(")
			&& main.includes("this.corruptBlobSettledRefStoreKeys.delete(")
			&& main.includes("this.pendingBlobIntents.clear()")
			&& main.includes("delete nextState._pendingBlobIntents"),
		"only nuclear reset clears both corrupt scoped stores/latches and legacy data.json authority",
	);

	const captureResolutionStart = main.indexOf("private captureCommittedBlobIntentResolution(");
	const clearAttentionStart = main.indexOf("private async clearPreservedUnresolvedAttention(", captureResolutionStart);
	const resolution = main.slice(captureResolutionStart, clearAttentionStart);
	assert(
		resolution.includes("intent.commitDeleteFingerprint === remoteDeleteFingerprint")
			&& resolution.includes("token.episodeId !== target.episodeId")
			&& resolution.includes("token.remoteDeleteFingerprint !== target.remoteDeleteFingerprint")
			&& resolution.includes("enqueuePendingBlobIntentPersistence()"),
		"explicit Dashboard resolution supersedes only journal entries bound to its exact UI+tombstone episode",
	);
	const resolveActionStart = main.indexOf("private async resolveRemoteDeleteAttention(");
	const resolveAction = main.slice(resolveActionStart, captureResolutionStart);
	const captureToken = resolveAction.indexOf("captureCommittedBlobIntentResolution(normalizedTarget)");
	const keepLocal = resolveAction.indexOf("blobSync.keepLocalRemoteDeletedBlob(", captureToken);
	const keepScopeCapture = resolveAction.lastIndexOf(
		"const blobQueuePersistenceScope",
		keepLocal,
	);
	const keepQueueDurable = resolveAction.indexOf(
		"await this.persistBlobQueueSnapshot(",
		keepLocal,
	);
	const keepScopeArgument = resolveAction.indexOf(
		"blobQueuePersistenceScope",
		keepQueueDurable,
	);
	const keepSupersede = resolveAction.indexOf(
		"await this.supersedeCommittedBlobIntentsForResolution(",
		keepQueueDurable,
	);
	const acceptRemote = resolveAction.indexOf("await blobSync.acceptRemoteDeletedBlob(", keepSupersede);
	const acceptSupersede = resolveAction.indexOf(
		"await this.supersedeCommittedBlobIntentsForResolution(",
		acceptRemote,
	);
	assert(
		captureToken >= 0
			&& keepLocal > captureToken
			&& keepScopeCapture > captureToken
			&& keepScopeCapture < keepLocal
			&& keepQueueDurable > keepLocal
			&& keepScopeArgument > keepQueueDurable
			&& keepScopeArgument < keepSupersede
			&& keepSupersede > keepQueueDurable
			&& acceptRemote > keepSupersede
			&& acceptSupersede > acceptRemote,
		"Keep local persists its replacement queue and Accept completes deletion before exact intent supersede",
	);

	const migrationResolverStart = main.indexOf(
		"private async resolveLegacyMissingBlobAttention(",
	);
	const migrationResolverEnd = main.indexOf(
		"private getCurrentLegacyMissingBlobAttention(",
		migrationResolverStart,
	);
	const migrationResolver = main.slice(migrationResolverStart, migrationResolverEnd);
	const exactBase = migrationResolver.indexOf("expectedSourceVersion,");
	const intentDurable = migrationResolver.indexOf(
		"await this.enqueuePendingBlobIntentPersistence()",
		exactBase,
	);
	const intentReplay = migrationResolver.indexOf(
		"await this.replayPendingBlobIntents(",
		intentDurable,
	);
	const commitCheck = migrationResolver.indexOf("?.committedAt !== undefined", intentReplay);
	const quarantineRelease = migrationResolver.indexOf(
		"await this.setLegacyMissingBlobQuarantine(normalizedTarget.path, false)",
		commitCheck,
	);
	assert(
		migrationResolverStart >= 0
			&& migrationResolver.includes("blobSync.acceptLegacyMissingRemoteBlob(")
			&& migrationResolver.includes("await this.persistBlobQueueSnapshot(")
			&& exactBase >= 0
			&& intentDurable > exactBase
			&& intentReplay > intentDurable
			&& commitCheck > intentReplay
			&& quarantineRelease > commitCheck
			&& !migrationResolver.includes("blobHashCache"),
		"upgrade Attention either queues the exact accepted ref or journals exact ref+CRDT-episode CAS authority before releasing quarantine",
	);
	const settledCallbackStart = main.indexOf("private handleBlobSettledRefsChanged(");
	const settledCallbackEnd = main.indexOf(
		"private async setLegacyMissingBlobQuarantine(",
		settledCallbackStart,
	);
	const settledCallback = main.slice(settledCallbackStart, settledCallbackEnd);
	assert(
		settledCallback.includes("path && ref")
			&& settledCallback.includes("sameBlobRef(this.blobSettledRefs[path], ref)")
			&& !settledCallback.includes("for (const path"),
		"an unrelated settlement cannot release a loaded legacy-missing path",
	);
	assert(
		blobSyncSource.includes("=== LEGACY_MISSING_BLOB_ATTENTION_REASON")
			&& blobSyncSource.includes("verifyLegacyMigrationPresentFile(path, file, remoteRef)")
			&& blobSyncSource.includes("hash !== expectedRemoteRef.hash")
			&& blobSyncSource.includes("currentFile !== file")
			&& blobSyncSource.includes("file.stat.mtime !== expectedMtime"),
		"observer/reconcile/prioritize stay fenced and crash-completed files recover only after exact identity/stat/hash verification",
	);
}

console.log(`\n${"─".repeat(65)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(65)}\n`);

process.exit(failed > 0 ? 1 : 0);
