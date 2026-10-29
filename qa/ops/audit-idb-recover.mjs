// Rebuild the note's Y.Text including deleted items:
// base = live room dump (current state), then re-apply every kaos-store Yjs
// update found in the WAL copy (gc disabled) so deleted fragments survive.
import { readFileSync, writeFileSync } from "node:fs";
import * as Y from "yjs";

const WAL = "/tmp/idb-extract/wal-578674.log";
const KEY_PREFIX = Buffer.from("00e0010103000000", "hex");

const data = readFileSync(WAL);
const BLOCK = 32768;
const entries = [];
for (let blockStart = 0; blockStart < data.length; blockStart += BLOCK) {
	const blockEnd = Math.min(blockStart + BLOCK, data.length);
	let pos = blockStart;
	let pending = null;
	while (pos + 7 <= blockEnd) {
		const len = data.readUInt16LE(pos + 4);
		const type = data[pos + 6];
		if (len > blockEnd - pos - 7) break;
		const payload = data.subarray(pos + 7, pos + 7 + len);
		pos += 7 + len;
		if (type === 1) {
			entries.push(pending ? Buffer.concat([...pending, payload]) : payload);
			pending = null;
		} else if (type === 2) {
			pending = [payload];
		} else if ((type === 3 || type === 4) && pending) {
			pending.push(payload);
			if (type === 4) {
				entries.push(Buffer.concat(pending));
				pending = null;
			}
		}
	}
}

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

function extractUpdate(value) {
	// Primary: parse the V8 ValueSerializer envelope — version header 0xFF 0x0F,
	// Uint8Array tag 0x42, varint byte length, raw Yjs update bytes.
	for (let i = 0; i < Math.min(value.length - 4, 64); i++) {
		if (value[i] === 0xff && value[i + 1] === 0x0f && value[i + 2] === 0x42) {
			const [lenVar, afterLen] = readVarint(value, i + 3);
			const candidate = value.subarray(afterLen, afterLen + Number(lenVar));
			if (candidate.length > 4) return candidate;
		}
	}
	// Fallback: brute-force start offsets, trimming a small trailing tail.
	for (let start = 0; start < Math.min(value.length, 200); start++) {
		if (value[start] === 0) continue; // empty-client-count false positive
		for (let trim = 0; trim <= 16; trim++) {
			const slice = value.subarray(start, value.length - trim);
			const probe = new Y.Doc();
			try {
				Y.applyUpdate(probe, slice);
			} catch {
				continue;
			}
			if (Y.encodeStateVector(probe).length <= 1) continue;
			return slice;
		}
	}
	return null;
}

const kaosEntries = [];
for (const batch of entries) {
	if (batch.length < 12) continue;
	let pos = 12;
	while (pos < batch.length) {
		const tag = batch[pos++];
		if (tag === 0) {
			const [klen, p] = readVarint(batch, pos);
			pos = p + Number(klen);
			continue;
		}
		if (tag !== 1) break;
		let [klen, p] = readVarint(batch, pos);
		const key = batch.subarray(p, p + Number(klen));
		p += Number(klen);
		const [vlen, vp] = readVarint(batch, p);
		const value = batch.subarray(vp, vp + Number(vlen));
		pos = vp + Number(vlen);
		if (key.subarray(0, KEY_PREFIX.length).equals(KEY_PREFIX) && value.length > 8) {
			kaosEntries.push({ key, value });
		}
	}
}
console.log(`kaos-store WAL entries: ${kaosEntries.length}`);

const updates = [];
for (const e of kaosEntries) {
	const bytes = extractUpdate(e.value);
	if (bytes) updates.push(bytes);
}
console.log(`valid Yjs updates: ${updates.length}`);

const doc = new Y.Doc();
doc.gc = false;
// Seed from the 10-03 daily snapshot (room state as of 10-03 23:04 KST):
// it has the file structure but predates today's home-client clocks, so the
// paragraph inserts in the WAL still integrate instead of colliding with
// GC'd clock ranges from the live state.
Y.applyUpdate(doc, new Uint8Array(readFileSync("/tmp/snap-1003.bin")));
let applied = 0;
for (const bytes of updates) {
	try {
		Y.applyUpdate(doc, bytes);
		applied++;
	} catch {
		/* skip */
	}
}
console.log(`base + ${applied} WAL updates applied`);

const ytext = doc.getMap("idToText").get("GN58VmmVkruqYhIc");
if (!ytext) {
	console.log("note Y.Text not found");
	process.exit(1);
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
console.log(`items: ${chunks.length}, alive: ${Buffer.byteLength(alive)}B, deleted: ${Buffer.byteLength(dead)}B`);
writeFileSync("/tmp/note-recovered-alive.txt", alive);
writeFileSync("/tmp/note-recovered-deleted.txt", dead);
writeFileSync(
	"/tmp/note-recovered-items.json",
	JSON.stringify(chunks.map((c) => ({ client: c.client, clock: c.clock, deleted: c.deleted, len: c.s.length, head: c.s.slice(0, 30) })), null, 1),
);
console.log("DELETED text:");
console.log(dead.slice(0, 1500));
