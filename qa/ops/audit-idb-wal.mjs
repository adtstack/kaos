// Pure-JS LevelDB WAL (.log) parser: extract WriteBatch records whose values
// contain the note's distinctive text, then recover the Yjs update bytes.
// LevelDB log format: 32KiB blocks; record header = crc32c(4) len(2 LE) type(1).
// WriteBatch payload: seq(8) count(4 LE) then [type(1) klen(varint) key vlen(varint) value]*.
import { readFileSync, writeFileSync } from "node:fs";
import * as Y from "yjs";

const LOG = process.argv[2] ?? "/tmp/idb-extract/kaos-copy.leveldb/578674.log";
const NEEDLES = [
	"든다. 하지만",
	"해선이",
	"들고 ㅇ",
	"혼자 있다보니까",
].map((s) => Buffer.from(s, "utf8"));

const data = readFileSync(LOG);
const BLOCK = 32768;
const entries = [];
for (let blockStart = 0; blockStart < data.length; blockStart += BLOCK) {
	const blockEnd = Math.min(blockStart + BLOCK, data.length);
	let pos = blockStart;
	let pending = null;
	while (pos + 7 <= blockEnd) {
		const len = data.readUInt16LE(pos + 4);
		const type = data[pos + 6];
		if (len > blockEnd - pos - 7) break; // truncated tail
		const payload = data.subarray(pos + 7, pos + 7 + len);
		pos += 7 + len;
		if (type === 1) {
			entries.push(payload);
			pending = null;
		} else if (type === 2) {
			pending = [payload];
		} else if (type === 3 && pending) {
			pending.push(payload);
		} else if (type === 4 && pending) {
			pending.push(payload);
			entries.push(Buffer.concat(pending));
			pending = null;
		} else if (type === 1 && pending) {
			entries.push(Buffer.concat([...pending, payload]));
			pending = null;
		}
	}
}
console.log(`log records: ${entries.length}`);

function readVarint(buf, pos) {
	let shift = 0;
	let value = 0n;
	while (true) {
		const b = buf[pos++];
		value |= BigInt(b & 0x7f) << BigInt(shift);
		if (!(b & 0x80)) break;
		shift += 7;
	}
	return [value, pos];
}

const hits = [];
for (const batch of entries) {
	if (batch.length < 12) continue;
	let pos = 12; // seq(8) + count(4)
	while (pos < batch.length) {
		const tag = batch[pos++];
		if (tag === 0) {
			const [klen, p] = readVarint(batch, pos);
			pos = p + Number(klen);
			continue;
		}
		if (tag !== 1) break; // only value-puts supported here
		let [klen, p] = readVarint(batch, pos);
		const key = batch.subarray(p, p + Number(klen));
		p += Number(klen);
		let [vlen, p2] = readVarint(batch, p);
		const value = batch.subarray(p2, p2 + Number(vlen));
		p2 += Number(vlen);
		pos = p2;
		const matched = NEEDLES.filter((n) => value.includes(n));
		if (matched.length > 0) {
			hits.push({ key, value, matched: matched.map((m) => m.toString("utf8")) });
		}
	}
}
console.log(`matching IDB entries: ${hits.length}`);

function extractUpdate(value) {
	for (let start = 0; start < Math.min(value.length, 200); start++) {
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

const updates = [];
for (const h of hits) {
	const bytes = extractUpdate(h.value);
	updates.push({ matched: h.matched, keyLen: h.key.length, bytes, keyHead: h.key.subarray(0, 8).toString("hex") });
}
const okCount = updates.filter((u) => u.bytes).length;
console.log(`extracted valid Yjs updates: ${okCount}/${updates.length}`);
writeFileSync(
	"/tmp/wal-hit-index.json",
	JSON.stringify(updates.map((u, i) => ({ i, matched: u.matched, keyHead: u.keyHead, len: u.bytes ? u.bytes.length : null })), null, 1),
);
for (const u of updates) {
	if (u.bytes) writeFileSync(`/tmp/wal-update-${updates.indexOf(u)}.bin`, u.bytes);
}

// Rebuild gc=false doc from every extracted update.
const doc = new Y.Doc();
doc.gc = false;
let applied = 0;
for (const u of updates) {
	if (!u.bytes) continue;
	try {
		Y.applyUpdate(doc, u.bytes);
		applied++;
	} catch {
		/* conflicting partial stream is fine for text recovery */
	}
}
console.log(`applied ${applied}`);
const ytext = doc.getMap("idToText").get("GN58VmmVkruqYhIc");
if (!ytext) {
	console.log("note Y.Text not found");
	process.exit(0);
}
const chunks = [];
let item = ytext._start;
while (item) {
	const c = item.content;
	if (c && c.str !== undefined) chunks.push({ deleted: !!item.deleted, s: c.str, clock: item.id.clock, client: item.id.client });
	item = item.right;
}
const alive = chunks.filter((c) => !c.deleted).map((c) => c.s).join("");
const dead = chunks.filter((c) => c.deleted).map((c) => c.s).join("");
console.log(`items: ${chunks.length}, alive bytes: ${Buffer.byteLength(alive)}, deleted bytes: ${Buffer.byteLength(dead)}`);
const byClient = {};
for (const c of chunks) {
	byClient[c.client] ??= { items: 0, deleted: 0, chars: 0 };
	byClient[c.client].items++;
	if (c.deleted) byClient[c.client].deleted++;
	byClient[c.client].chars += c.s.length;
}
console.log("by client:", JSON.stringify(byClient));
writeFileSync("/tmp/note-recovered-alive.txt", alive);
writeFileSync("/tmp/note-recovered-deleted.txt", dead);
console.log("ALIVE head:", JSON.stringify(alive.slice(0, 200)));
console.log("DELETED head:", JSON.stringify(dead.slice(0, 400)));
