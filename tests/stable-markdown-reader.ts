import assert from "node:assert/strict";
import { readStableMarkdownSnapshot } from "../src/runtime/stableMarkdownReader";

const file = { path: "note.md" };
const stableStat = { mtime: 10, size: 4 };

console.log("\n--- Stable Markdown stat failure classification ---");

{
	const traces: string[] = [];
	const result = await readStableMarkdownSnapshot({
		stat: async () => { throw new Error("storage temporarily unavailable"); },
		getFile: () => file,
		read: async () => "text",
		trace: (message) => { traces.push(message); },
		sleep: async () => {},
	}, file.path, "modify");
	assert.deepEqual(result, { kind: "unstable" });
	assert.deepEqual(traces, ["markdown-stable-read-stat-unavailable"]);
}

{
	const result = await readStableMarkdownSnapshot({
		stat: async () => null,
		getFile: () => file,
		read: async () => "text",
		trace: () => {},
		sleep: async () => {},
	}, file.path, "modify");
	assert.deepEqual(result, { kind: "missing" });
}

{
	let statCalls = 0;
	const result = await readStableMarkdownSnapshot({
		stat: async () => {
			statCalls++;
			if (statCalls === 4) throw new Error("mount woke during read");
			return stableStat;
		},
		getFile: () => file,
		read: async () => "text",
		trace: () => {},
		sleep: async () => {},
	}, file.path, "modify");
	assert.deepEqual(result, { kind: "unstable" }, "post-read stat rejection is retryable, not missing");
}

{
	const result = await readStableMarkdownSnapshot({
		stat: async () => stableStat,
		getFile: () => file,
		read: async () => "text",
		trace: () => {},
		sleep: async () => {},
	}, file.path, "modify");
	assert.deepEqual(result, {
		kind: "ready",
		file,
		content: "text",
		stat: stableStat,
	});
}

{
	const traces: string[] = [];
	const result = await readStableMarkdownSnapshot({
		stat: async () => stableStat,
		getFile: () => null,
		read: async () => "unreachable",
		trace: (message) => { traces.push(message); },
		sleep: async () => {},
	}, file.path, "modify");
	assert.deepEqual(result, { kind: "unstable" }, "vault-index lag is retryable, not a deletion");
	assert.deepEqual(traces, ["markdown-stable-read-file-unavailable"]);
}

{
	const traces: string[] = [];
	const result = await readStableMarkdownSnapshot({
		stat: async () => stableStat,
		getFile: () => file,
		read: async () => { throw new Error("mobile storage waking"); },
		trace: (message) => { traces.push(message); },
		sleep: async () => {},
	}, file.path, "modify");
	assert.deepEqual(result, { kind: "unstable" }, "transient read rejection is requeued");
	assert.deepEqual(traces, ["markdown-stable-read-file-unavailable"]);
}

console.log("PASS Stable Markdown stat failure classification");
