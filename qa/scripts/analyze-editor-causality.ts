import { readFileSync, writeFileSync } from "node:fs";
import { analyzeEditorCausality, type CausalityEvent } from "../analyzers/editorCausality";

const args = process.argv.slice(2);
const files: string[] = [];
let output: string | undefined;
for (let index = 0; index < args.length; index++) {
	const arg = args[index]!;
	if (arg === "--out") {
		output = args[++index];
		if (!output) throw new Error("--out requires a report path");
	} else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
	else files.push(arg);
}
if (files.length === 0) throw new Error("Supply exported flight trace NDJSON files.");
const events: CausalityEvent[] = [];
for (const file of files) {
	for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
		if (!line.trim()) continue;
		let event: CausalityEvent;
		try { event = JSON.parse(line) as CausalityEvent; }
		catch { throw new Error(`Malformed NDJSON at ${file}:${index + 1}`); }
		if (!event.kind || !Number.isSafeInteger(event.seq)) throw new Error(`Invalid flight event at ${file}:${index + 1}`);
		events.push(event);
	}
}
const report = JSON.stringify(analyzeEditorCausality(events), null, 2) + "\n";
if (output) writeFileSync(output, report);
else process.stdout.write(report);
