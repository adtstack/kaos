// Apply WAL kaos updates (seeded from the 10-03 snapshot) in order onto a
// gc=false doc, printing transaction effects for records of interest:
// which map/key changed, and any `device` values seen (client<->device map).
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

const updates = [];
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
		for (const u of v8Updates(value)) if (u.length >= 4) updates.push(u);
	}
}
console.log(`updates: ${updates.length}`);

const doc = new Y.Doc();
doc.gc = false;
Y.applyUpdate(doc, new Uint8Array(readFileSync("/tmp/snap-1003.bin")));

const deviceByClient = {};
const watchSet = new Set(process.argv.slice(2).map(Number));
let currentClients = new Set();
let recordEffects = false;
doc.on("afterTransaction", (tr) => {
	const meta = doc.getMap("meta");
	for (const [type] of tr.changed) {
		if (type !== meta) continue;
		for (const k of tr.changed.get(type).keys.keys()) {
			const v = meta.get(k);
			if (v instanceof Y.Map) {
				const dev = v.get("device");
				const path = v.get("path");
				if (dev) {
					for (const c of currentClients) {
						const prev = deviceByClient[c] ?? new Set();
						prev.add(`${dev}:${path}`);
						deviceByClient[c] = prev;
					}
					if (recordEffects) console.log(`  meta[${k}] path=${path} device=${dev} authors=[${[...currentClients]}]`);
				}
			}
		}
	}
});

let idx = 0;
for (const u of updates) {
	let clients = new Set();
	try {
		for (const s of Y.decodeUpdate(u).structs ?? []) clients.add(s.id?.client);
	} catch {
		/* decode fail */
	}
	currentClients = clients;
	recordEffects = watchSet.has(idx);
	if (recordEffects) console.log(`\n== update #${idx} authors=[${[...clients]}] ==`);
	try {
		Y.applyUpdate(doc, u);
	} catch (e) {
		if (recordEffects) console.log("  apply error:", e.message.slice(0, 80));
	}
	idx++;
}
console.log("\nclient -> device:path attributions:");
for (const [c, set] of Object.entries(deviceByClient)) console.log(`  ${c}: ${[...set].slice(0, 6).join(" | ")}`);

// Final: what does the churn item look like? Show sys map and a slice of meta.
const sys = doc.getMap("sys");
console.log("\nsys keys:", JSON.stringify([...sys.keys()]));
const sysJson = {};
for (const [k, v] of sys.entries()) sysJson[k] = v instanceof Y.AbstractType ? "<ytype>" : v;
console.log("sys content:", JSON.stringify(sysJson).slice(0, 500));
const note = doc.getMap("idToText").get("GN58VmmVkruqYhIc");
console.log("note bytes:", note ? Buffer.byteLength(note.toString()) : "missing");
