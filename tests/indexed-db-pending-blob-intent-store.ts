import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import {
	IndexedDbPendingBlobIntentStore,
	buildPendingBlobIntentStoreKey,
} from "../src/sync/indexedDbPendingBlobIntentStore";
import {
	PendingBlobIntentJournal,
	type PendingBlobIntent,
	type PendingBlobIntentScope,
} from "../src/sync/pendingBlobIntentJournal";
import type { BlobRef } from "../src/types";

const SCOPE: PendingBlobIntentScope = {
	host: "https://sync.example",
	vaultId: "vault-a",
	localDeviceId: "device-a",
};
const REF_A: BlobRef = { hash: "a".repeat(64), size: 10 };
const REF_B: BlobRef = { hash: "b".repeat(64), size: 20 };
const DELETE_FINGERPRINT = "delete-episode-fingerprint";

function uniqueDbName(label: string): string {
	return `kaos-pending-blob-intent-${label}-${Date.now()}-${Math.random()}`;
}

function jsonValue<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function deleteIntent(
	scope: PendingBlobIntentScope,
	path: string,
	recordedAt: number,
): PendingBlobIntent {
	return new PendingBlobIntentJournal()
		.recordDelete(path, scope, { known: true, ref: REF_A }, recordedAt);
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(dbName);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("test database open failed"));
	});
}

async function putRaw(dbName: string, key: string, value: unknown): Promise<void> {
	const db = await openDatabase(dbName);
	await new Promise<void>((resolve, reject) => {
		const transaction = db.transaction("intentJournals", "readwrite");
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("test write failed"));
		transaction.onabort = () => reject(transaction.error ?? new Error("test write aborted"));
		transaction.objectStore("intentJournals").put(value, key);
	});
	db.close();
}

console.log("\n--- IndexedDB pending blob intents: exact scope keys ---");
{
	assert.equal(
		buildPendingBlobIntentStoreKey(SCOPE),
		'kaos-blob-intent-v1:["https://sync.example","vault-a","device-a"]',
	);
	assert.notEqual(
		buildPendingBlobIntentStoreKey({ host: "a:b", vaultId: "c", localDeviceId: "d" }),
		buildPendingBlobIntentStoreKey({ host: "a", vaultId: "b:c", localDeviceId: "d" }),
		"tuple encoding must not permit delimiter collisions",
	);
	assert.throws(
		() => buildPendingBlobIntentStoreKey({ ...SCOPE, localDeviceId: "" }),
		/scope requires/i,
	);
}

console.log("\n--- IndexedDB pending blob intents: durable round trip ---");
{
	const dbName = uniqueDbName("round-trip");
	const journal = new PendingBlobIntentJournal();
	const pendingDelete = journal.recordDelete(
		"assets/a.png",
		SCOPE,
		{ known: true, ref: REF_A },
		100,
	);
	const committedRename = journal.recordRename(
		"assets/b.png",
		"assets/c.png",
		SCOPE,
		{ known: true, ref: REF_B },
		200,
	);
	assert.ok(committedRename);
	assert.equal(
		journal.markCommitted(
			committedRename.id,
			300,
			"session-a",
			"candidate-a",
			DELETE_FINGERPRINT,
		),
		true,
	);

	await new IndexedDbPendingBlobIntentStore(SCOPE, indexedDB, dbName)
		.save(journal.getEntries());
	const restored = await new IndexedDbPendingBlobIntentStore(SCOPE, indexedDB, dbName).load();
	assert.deepEqual(jsonValue(restored), jsonValue(journal.getEntries(SCOPE)));
	assert.equal(restored[0]?.id, pendingDelete.id);
	assert.equal(restored[1]?.commitDeleteFingerprint, DELETE_FINGERPRINT);

	(restored[0] as Extract<PendingBlobIntent, { kind: "delete" }>).path = "mutated.png";
	const restoredAgain = await new IndexedDbPendingBlobIntentStore(SCOPE, indexedDB, dbName).load();
	assert.equal(
		(restoredAgain[0] as Extract<PendingBlobIntent, { kind: "delete" }>).path,
		"assets/a.png",
		"loaded entries must be defensive structured clones",
	);
}

console.log("\n--- IndexedDB pending blob intents: host/vault/device isolation ---");
{
	const dbName = uniqueDbName("scope");
	const scopes: PendingBlobIntentScope[] = [
		SCOPE,
		{ ...SCOPE, host: "https://other.example" },
		{ ...SCOPE, vaultId: "vault-b" },
		{ ...SCOPE, localDeviceId: "device-b" },
	];
	for (const [index, scope] of scopes.entries()) {
		await new IndexedDbPendingBlobIntentStore(scope, indexedDB, dbName)
			.save([deleteIntent(scope, `assets/${index}.png`, 100 + index)]);
	}
	for (const [index, scope] of scopes.entries()) {
		const loaded = await new IndexedDbPendingBlobIntentStore(scope, indexedDB, dbName).load();
		assert.equal(loaded.length, 1);
		assert.equal((loaded[0] as Extract<PendingBlobIntent, { kind: "delete" }>).path, `assets/${index}.png`);
	}

	await new IndexedDbPendingBlobIntentStore(SCOPE, indexedDB, dbName).clear();
	assert.deepEqual(await new IndexedDbPendingBlobIntentStore(SCOPE, indexedDB, dbName).load(), []);
	assert.equal(
		(await new IndexedDbPendingBlobIntentStore(scopes[1]!, indexedDB, dbName).load()).length,
		1,
		"clear must not erase another host scope",
	);
}

console.log("\n--- IndexedDB pending blob intents: save filters foreign entries ---");
{
	const dbName = uniqueDbName("filter");
	const foreignScope = { ...SCOPE, localDeviceId: "device-foreign" };
	const own = deleteIntent(SCOPE, "assets/own.png", 100);
	const foreign = deleteIntent(foreignScope, "assets/foreign.png", 200);
	const store = new IndexedDbPendingBlobIntentStore(SCOPE, indexedDB, dbName);
	await store.save([foreign, own]);
	assert.deepEqual(jsonValue(await store.load()), jsonValue([own]));
	assert.deepEqual(
		await new IndexedDbPendingBlobIntentStore(foreignScope, indexedDB, dbName).load(),
		[],
		"saving one scope must not create or overwrite a foreign device record",
	);
}

console.log("\n--- IndexedDB pending blob intents: invalid saves reject atomically ---");
{
	const dbName = uniqueDbName("invalid-save");
	const store = new IndexedDbPendingBlobIntentStore(SCOPE, indexedDB, dbName);
	const valid = deleteIntent(SCOPE, "assets/valid.png", 100);
	await store.save([valid]);
	await assert.rejects(
		store.save([valid, {
			...valid,
			id: "invalid-lineage",
			expectedSourceRef: {
				...REF_A,
				priorHashes: [REF_B.hash, REF_B.hash],
			},
		}]),
		/invalid pending blob intent journal/i,
	);
	assert.deepEqual(
		jsonValue(await store.load()),
		jsonValue([valid]),
		"a rejected save preserves the last complete intent journal",
	);
}

console.log("\n--- IndexedDB pending blob intents: corrupt data fails closed ---");
{
	const dbName = uniqueDbName("corrupt");
	const store = new IndexedDbPendingBlobIntentStore(SCOPE, indexedDB, dbName);
	assert.deepEqual(await store.loadWithStatus(), { entries: [], status: "missing" });
	await store.save([]);
	assert.deepEqual(await store.loadWithStatus(), { entries: [], status: "loaded" });
	const key = buildPendingBlobIntentStoreKey(SCOPE);
	const valid = deleteIntent(SCOPE, "assets/valid.png", 100);

	await putRaw(dbName, key, { schema: 2, scope: SCOPE, entries: [valid] });
	assert.deepEqual(
		await store.loadWithStatus(),
		{ entries: [], status: "corrupt" },
		"unsupported payload schemas fail closed with an authority-blocking signal",
	);

	await putRaw(dbName, key, {
		schema: 1,
		scope: { ...SCOPE, localDeviceId: "foreign" },
		entries: [valid],
	});
	assert.deepEqual(await store.load(), [], "payload scope mismatches fail closed");

	await putRaw(dbName, key, {
		schema: 1,
		scope: SCOPE,
		entries: [valid, { kind: "delete", path: 42 }],
	});
	assert.deepEqual(await store.load(), [], "partially corrupt journals are never partially accepted");

	await putRaw(dbName, key, {
		schema: 1,
		scope: SCOPE,
		entries: [{
			...valid,
			expectedSourceRef: {
				...REF_A,
				priorHashes: [REF_B.hash, REF_B.hash],
			},
		}],
	});
	assert.deepEqual(
		await store.loadWithStatus(),
		{ entries: [], status: "corrupt" },
		"malformed causal lineage is corruption, not silently normalized authority",
	);

	await putRaw(dbName, key, {
		schema: 1,
		scope: SCOPE,
		entries: [{
			...valid,
			expectedSourceRef: {
				...REF_A,
				priorHashes: Array.from(
					{ length: 17 },
					(_, index) => (index + 1).toString(16).padStart(64, "0"),
				),
			},
		}],
	});
	assert.deepEqual(
		await store.loadWithStatus(),
		{ entries: [], status: "corrupt" },
		"an oversized causal lineage cannot be truncated into trusted authority",
	);

	await putRaw(dbName, key, {
		schema: 1,
		scope: SCOPE,
		entries: [{
			...valid,
			committedAt: 123,
			commitDeleteFingerprint: DELETE_FINGERPRINT,
		}],
	});
	assert.deepEqual(
		await store.loadWithStatus(),
		{ entries: [], status: "corrupt" },
		"a committed fingerprint without its commit session fails closed",
	);

	const failedFactory = {
		open(): IDBOpenDBRequest {
			throw new Error("IndexedDB unavailable");
		},
	};
	await assert.rejects(
		new IndexedDbPendingBlobIntentStore(
			SCOPE,
			failedFactory as Pick<IDBFactory, "open">,
			"unavailable",
		).load(),
		/IndexedDB unavailable/,
		"operational read failure must block authority instead of looking empty",
	);
	await assert.rejects(
		new IndexedDbPendingBlobIntentStore(
			SCOPE,
			failedFactory as Pick<IDBFactory, "open">,
			"unavailable-status",
		).loadWithStatus(),
		/IndexedDB unavailable/,
	);
}

console.log("\n--- Pending blob intent journal: committed episodes are immutable ---");
{
	const journal = new PendingBlobIntentJournal();
	const committedRename = journal.recordRename(
		"assets/a.png",
		"assets/b.png",
		SCOPE,
		{ known: true, ref: REF_A },
		100,
	);
	assert.ok(committedRename);
	assert.equal(journal.markCommitted(committedRename.id, 150, "session-a", "candidate-a"), true);
	assert.equal(journal.markCommitted(committedRename.id, 999, "session-b", "candidate-b"), false);

	const deleteB = journal.recordDelete(
		"assets/b.png",
		SCOPE,
		{ known: true, ref: REF_B },
		200,
	);
	const entries = journal.getEntries(SCOPE);
	assert.equal(entries.length, 2, "committed A -> B followed by deleting B is a separate episode");
	assert.notEqual(deleteB.id, committedRename.id);
	assert.deepEqual(entries[0], {
		...committedRename,
		committedAt: 150,
		commitSessionId: "session-a",
		receiptCandidateId: "candidate-a",
	});

	const renameJournal = new PendingBlobIntentJournal(entries.slice(0, 1));
	const renameB = renameJournal.recordRename(
		"assets/b.png",
		"assets/c.png",
		SCOPE,
		{ known: true, ref: REF_B },
		300,
	);
	assert.ok(renameB);
	assert.notEqual(renameB.id, committedRename.id);
	assert.equal(renameJournal.getEntries(SCOPE).length, 2, "committed A -> B followed by B -> C is a separate episode");

	const committedDeleteJournal = new PendingBlobIntentJournal();
	const committedDelete = committedDeleteJournal.recordDelete(
		"assets/b.png",
		SCOPE,
		{ known: true, ref: REF_B },
		400,
	);
	assert.equal(committedDeleteJournal.markCommitted(committedDelete.id, 450, "session-c"), true);
	assert.ok(committedDeleteJournal.recordRename(
		"assets/b.png",
		"assets/c.png",
		SCOPE,
		{ known: false },
		500,
	));
	assert.equal(
		committedDeleteJournal.getEntries(SCOPE).length,
		2,
		"a committed delete cannot suppress a later source-path mutation",
	);
}

console.log("\nIndexedDB pending blob intent store: all tests passed\n");
