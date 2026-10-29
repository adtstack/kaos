// Read-only fetch helper: node audit-fetch.mjs <resource-path> [outFile]
import { readFileSync, writeFileSync } from "node:fs";

const session = JSON.parse(readFileSync("/tmp/kaos-audit-session.json", "utf8"));
const path = process.argv[2];
const outFile = process.argv[3];

const res = await fetch(`${session.host}${path}`, {
	headers: { Authorization: `Bearer ${session.bearer}` },
});
if (!res.ok) {
	const text = await res.text();
	console.error(`GET ${path} -> ${res.status}: ${text.slice(0, 300)}`);
	process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
if (outFile) {
	writeFileSync(outFile, buf);
	console.log(`GET ${path} -> ${res.status}, ${buf.length} bytes -> ${outFile}`);
} else {
	console.log(buf.toString("utf8"));
}
