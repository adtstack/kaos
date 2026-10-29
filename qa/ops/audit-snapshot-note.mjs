// Extract a file's text + meta from a downloaded room snapshot (read-only).
// usage: node audit-snapshot-note.mjs <snapshot.gz> <path-substring> [outFile]
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import * as Y from "yjs";

const [file, needle, outFile] = process.argv.slice(2);
const raw = gunzipSync(readFileSync(file));
const doc = new Y.Doc();
Y.applyUpdate(doc, raw);

const meta = doc.getMap("meta");
const idToText = doc.getMap("idToText");
for (const [fileId, value] of meta.entries()) {
	const path = value?.path ?? value?.get?.("path");
	if (typeof path !== "string" || !path.includes(needle)) continue;
	const ytext = idToText.get(fileId);
	const text = ytext ? ytext.toString() : "<no ytext>";
	const plain = value instanceof Y.Map
		? Object.fromEntries(value.entries())
		: value;
	console.log(`=== ${file} fileId=${fileId} ===`);
	console.log("meta:", JSON.stringify(plain, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
	console.log(`text bytes: ${Buffer.byteLength(text)}`);
	if (outFile) {
		writeFileSync(outFile, text);
		console.log(`-> ${outFile}`);
	} else {
		console.log("---");
		console.log(text);
		console.log("---");
	}
}
