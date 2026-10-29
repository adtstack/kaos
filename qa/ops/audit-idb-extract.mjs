// Recover the deleted 10-02 note paragraph from this Mac's kaos y-indexeddb
// (copy at /tmp/idb-extract/kaos-copy.leveldb). Read-only forensic extraction.
// Strategy: only records whose value contains note-distinctive text carry the
// note's insert updates; for each, find the wrapper-header offset whose
// remainder decodes as a valid Yjs update, rebuild a gc=false doc, and walk
// the note's Y.Text items (alive + deleted).
import { ClassicLevel } from "/tmp/idb-extract/node_modules/classic-level/index.js";
import * as Y from "yjs";
import { writeFileSync } from "node:fs";

const NEEDLES = [
	"든다. 하지만",
	"해선이",
	"들고 ㅇ",
	"잘된다? 진짜?",
	"혼자 있다보니까",
	"오늘의 생각",
].map((s) => Buffer.from(s, "utf8"));

const db = new ClassicLevel("/tmp/idb-extract/kaos-copy.leveldb", {
	keyEncoding: "buffer",
	valueEncoding: "buffer",
});

function extractUpdate(value) {
	for (let start = 0; start < Math.min(value.length, 160); start++) {
		const slice = value.subarray(start);
		const probe = new Y.Doc();
		try {
			Y.applyUpdate(probe, slice);
		} catch {
			continue;
		}
		return slice;
	}
	return null;
}

let scanned = 0;
let matched = 0;
const updates = [];
for await (const [key, value] of db.iterator()) {
	scanned++;
	if (value.length < 8) continue;
	const hits = NEEDLES.filter((n) => value.includes(n));
	if (hits.length === 0) continue;
	matched++;
	const update = extractUpdate(value);
	updates.push({
		key: key.toString("hex").slice(0, 20),
		bytes: update,
		hits: hits.map((n) => n.toString("utf8")),
	});
}
console.log(`scanned ${scanned} records, matched ${matched}, extracted ${updates.filter((u) => u.bytes).length} updates`);
writeFileSync(
	"/tmp/note-update-index.json",
	JSON.stringify(updates.map((u) => ({ key: u.key, hits: u.hits, len: u.bytes ? u.bytes.length : null })), null, 1),
);

const doc = new Y.Doc();
doc.gc = false;
let applied = 0;
for (const { bytes } of updates) {
	if (!bytes) continue;
	try {
		Y.applyUpdate(doc, bytes);
		applied++;
	} catch {
		/* skip */
	}
}
console.log(`applied ${applied} updates to gc=false doc`);

const ytext = doc.getMap("idToText").get("GN58VmmVkruqYhIc");
if (!ytext) {
	console.log("note Y.Text not found in reconstructed doc");
	process.exit(0);
}
const chunks = [];
let item = ytext._start;
while (item) {
	const c = item.content;
	if (c && c.str !== undefined) {
		chunks.push({ deleted: !!item.deleted, s: c.str, clock: item.id.clock, client: item.id.client });
	}
	item = item.right;
}
const alive = chunks.filter((c) => !c.deleted).map((c) => c.s).join("");
const dead = chunks.filter((c) => c.deleted).map((c) => c.s).join("");
console.log(`items: ${chunks.length}, alive bytes: ${Buffer.byteLength(alive)}, deleted bytes: ${Buffer.byteLength(dead)}`);
const byClient = {};
for (const c of chunks) {
	byClient[c.client] ??= { items: 0, deleted: 0, bytes: 0 };
	byClient[c.client].items++;
	if (c.deleted) byClient[c.client].deleted++;
	byClient[c.client].bytes += Buffer.byteLength(c.s);
}
console.log("by client:", JSON.stringify(byClient));
writeFileSync("/tmp/note-recovered-alive.txt", alive);
writeFileSync("/tmp/note-recovered-deleted.txt", dead);
writeFileSync(
	"/tmp/note-recovered-items.json",
	JSON.stringify(chunks.map((c) => ({ client: c.client, clock: c.clock, deleted: c.deleted, len: c.s.length, head: c.s.slice(0, 30) })), null, 1),
);
console.log("deleted head:", JSON.stringify(dead.slice(0, 300)));
await db.close();
