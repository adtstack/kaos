import assert from "node:assert/strict";
import { createHeadlessIndexedDbFactory } from "../src/headless-host/core/indexedDb";

const factory = createHeadlessIndexedDbFactory();
const db = await new Promise<IDBDatabase>((resolve, reject) => {
	const request = factory.open("retention-regression", 1);
	request.onupgradeneeded = () => request.result.createObjectStore("aux");
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => reject(request.error);
});
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => reject(request.error);
});
const write = (value: unknown, abort = false) => new Promise<void>((resolve, reject) => {
	const transaction = db.transaction("aux", "readwrite");
	transaction.oncomplete = () => resolve();
	transaction.onabort = () => abort ? resolve() : reject(transaction.error);
	transaction.onerror = () => reject(transaction.error);
	const request = transaction.objectStore("aux").put(value, "snapshot");
	if (abort) request.onsuccess = () => transaction.abort();
});
const diskIndex = Object.fromEntries(Array.from({ length: 4144 }, (_, i) => [
	`NOTES/note-${i}.md`, { contentHash: "a".repeat(64), mtime: i, size: 2048 },
]));
for (let i = 0; i < 100; i++) await write({ diskIndex, savedAt: i });
await drain();
const raw = (db as IDBDatabase & { _rawDatabase: { transactions: unknown[] } })._rawDatabase;
assert.equal(raw.transactions.length, 0, "completed snapshots must not remain rooted by the factory");
const saved = await requestResult(db.transaction("aux").objectStore("aux").get("snapshot"));
assert.equal(saved.savedAt, 99);
assert.equal(Object.keys(saved.diskIndex).length, 4144);
await write({ savedAt: "aborted" }, true);
const afterAbort = await requestResult(db.transaction("aux").objectStore("aux").get("snapshot"));
assert.equal(afterAbort.savedAt, 99, "cleanup must preserve transaction rollback");
await Promise.all([write({ savedAt: 100 }), write({ savedAt: 101 })]);
const afterQueue = await requestResult(db.transaction("aux").objectStore("aux").get("snapshot"));
assert.equal(afterQueue.savedAt, 101, "cleanup must preserve queued transaction ordering");
await drain();
assert.equal(raw.transactions.length, 0);
db.close();
await requestResult(factory.deleteDatabase("retention-regression"));
console.log("PASS: repeated snapshots release transactions; abort, ordering, and database deletion work");
