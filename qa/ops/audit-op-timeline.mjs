// Operation-level timeline from the kaos y-indexeddb WAL copy:
// decode every stored update (structs + delete set) and answer:
//   1) which client authored the lost paragraph items
//   2) which update's delete set tombstoned them (and who authored that update)
import { readFileSync, writeFileSync } from "node:fs";
import * as Y from "yjs";

const data = readFileSync("/tmp/idb-extract/wal-578674-fresh.log");
const KEY_PREFIX = Buffer.from("00e0010103000000", "hex");
const BLOCK = 32768;

function readVarint(buf, pos) {
	let shift = 0;
	let value = 0n;
	for (;;) {
		const b = buf[pos++];
		value |= BigInt(b & 0x7f) << BigInt(shift);
		if (!(b & 0x80)) break;
		shift += 7;
	}
	return [value, pos];
}

const entries = [];
for (let bs = 0; bs < data.length; bs += BLOCK) {
	const be = Math.min(bs + BLOCK, data.length);
	let pos = bs;
	let pending = null;
	while (pos + 7 <= be) {
		const len = data.readUInt16LE(pos + 4);
		const type = data[pos + 6];
		if (len > be - pos - 7) break;
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

function v8Updates(value) {
	const out = [];
	for (let i = 0; i < Math.min(value.length - 6, 64); i++) {
		if (value[i] === 0xff && (value[i + 1] === 0x0f || value[i + 1] === 0x15) && value[i + 2] === 0x42) {
			const [lv, al] = readVarint(value, i + 3);
			out.push(value.subarray(al, al + Number(lv)));
		}
	}
	return out;
}

const records = [];
let seq = 0;
for (const batch of entries) {
	if (batch.length < 12) continue;
	let pos = 12;
	while (pos < batch.length) {
		const tag = batch[pos++];
		if (tag === 0) {
			const [kl, p] = readVarint(batch, pos);
			pos = p + Number(kl);
			continue;
		}
		if (tag !== 1) break;
		const [kl, p] = readVarint(batch, pos);
		const key = batch.subarray(p, p + Number(kl));
		const [vl, vp] = readVarint(batch, p + Number(kl));
		const value = batch.subarray(vp, vp + Number(vl));
		pos = vp + Number(vl);
		if (!key.subarray(0, 8).equals(KEY_PREFIX) || value.length < 12) continue;
		for (const u of v8Updates(value)) {
			if (u.length < 4) continue;
			let decoded = null;
			try {
				decoded = Y.decodeUpdate(u);
			} catch (e) {
				decoded = { error: e.message.slice(0, 60) };
			}
			records.push({ seq: seq++, key: key.toString("hex").slice(16), len: u.length, decoded });
		}
	}
}
console.log(`decoded records: ${records.length}, errors: ${records.filter((r) => r.decoded?.error).length}`);

const timeline = records.map((r) => {
	const structs = (r.decoded?.structs ?? []).map((s) => {
		const info = { client: s.id?.client, clock: s.id?.clock, len: s.len, ctor: s.constructor?.name };
		if (s.content?.str !== undefined) info.text = s.content.str.slice(0, 40);
		return info;
	});
	const ds = {};
	if (r.decoded?.ds?.clients) {
		for (const [client, ranges] of r.decoded.ds.clients) {
			ds[client] = (Array.isArray(ranges) ? ranges : [...ranges]).map((x) => Array.isArray(x) ? x.slice(0, 2) : [x.clock, x.len]);
		}
	}
	return { seq: r.seq, key: r.key, len: r.len, structs, ds };
});
writeFileSync("/tmp/op-timeline.json", JSON.stringify(timeline, null, 1));

// Summary: clients seen, delete-set targets
const clientStats = {};
for (const t of timeline) {
	for (const s of t.structs) {
		clientStats[s.client] ??= { structOps: 0, chars: 0 };
		clientStats[s.client].structOps++;
		if (s.text) clientStats[s.client].chars += s.text.length;
	}
}
console.log("struct-author clients:", JSON.stringify(clientStats));

const dsSummary = {};
for (const t of timeline) {
	for (const [client, ranges] of Object.entries(t.ds)) {
		const key = `delete:${client}`;
		dsSummary[key] = (dsSummary[key] ?? 0) + ranges.length;
	}
}
console.log("delete-set targets by client:", JSON.stringify(dsSummary));

// Show the records carrying deletes (with their struct authors)
for (const t of timeline) {
	const dsKeys = Object.keys(t.ds);
	if (dsKeys.length === 0) continue;
	console.log(`\n#${t.seq} key=${t.key} len=${t.len}`);
	console.log("  deletes:", JSON.stringify(t.ds));
	const authors = [...new Set(t.structs.map((s) => s.client))];
	console.log("  struct authors:", JSON.stringify(authors), "texts:", t.structs.filter((s) => s.text).map((s) => s.text.slice(0, 24)));
}
