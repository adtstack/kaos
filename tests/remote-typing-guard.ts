import {
	buildTypingAwareness,
	collectActiveRemoteTypers,
	formatRemoteTypers,
	KAOS_TYPING_AWARENESS_FIELD,
	REMOTE_TYPING_ACTIVE_MS,
} from "../src/sync/remoteTypingGuard";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

console.log("\n--- Test 1: active remote typing is collected for the same path ---");
{
	const now = 100_000;
	const states = new Map<number, Record<string, unknown>>([
		[1, { user: { name: "workspace" }, [KAOS_TYPING_AWARENESS_FIELD]: buildTypingAwareness("Notes/a.md", "workspace", now - 500) }],
		[2, { user: { name: "phone" }, [KAOS_TYPING_AWARENESS_FIELD]: buildTypingAwareness("Notes/b.md", "phone", now - 500) }],
	]);
	const peers = collectActiveRemoteTypers(states, 99, "Notes/a.md", now);
	assert(peers.length === 1, "one same-path remote typer is returned");
	assert(peers[0]?.deviceName === "workspace", "device name comes from typing awareness");
}

console.log("\n--- Test 2: stale and local typing states are ignored ---");
{
	const now = 200_000;
	const states = new Map<number, Record<string, unknown>>([
		[7, { [KAOS_TYPING_AWARENESS_FIELD]: buildTypingAwareness("Notes/a.md", "local", now) }],
		[8, { [KAOS_TYPING_AWARENESS_FIELD]: buildTypingAwareness("Notes/a.md", "stale", now - REMOTE_TYPING_ACTIVE_MS - 1) }],
	]);
	const peers = collectActiveRemoteTypers(states, 7, "Notes/a.md", now);
	assert(peers.length === 0, "local and stale states are not active conflicts");
}

console.log("\n--- Test 3: formatter summarizes multiple remote devices ---");
{
	const text = formatRemoteTypers([
		{ clientId: 1, deviceName: "phone", path: "Notes/a.md", at: 10 },
		{ clientId: 2, deviceName: "laptop", path: "Notes/a.md", at: 9 },
		{ clientId: 3, deviceName: "tablet", path: "Notes/a.md", at: 8 },
	]);
	assert(text === "phone and 2 other devices", "multiple typers are summarized");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
