import {
	evaluateRoomIdentityTransition,
	type RoomIdentityChangeInput,
} from "../src/runtime/roomTransitionPolicy";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function decide(overrides: Partial<RoomIdentityChangeInput>) {
	return evaluateRoomIdentityTransition({
		previousHost: "https://old.example.com",
		previousVaultId: "vault-old",
		nextHost: "https://old.example.com",
		nextVaultId: "vault-old",
		...overrides,
	});
}

console.log("\n--- Test 1: identical identity is a no-op (re-pair keeps state) ---");
{
	const decision = decide({});
	assert(decision.kind === "none", "same host + same vaultId → none");
}

console.log("\n--- Test 2: vaultId change resets room-scoped state ---");
{
	const decision = decide({ nextVaultId: "vault-new" });
	assert(decision.kind === "room-change", "vaultId change → room-change");
	if (decision.kind === "room-change") {
		assert(decision.resetRoomScopedState === true, "room-change requires a room-scoped reset");
		assert(decision.previousVaultId === "vault-old", "decision records the previous vaultId");
		assert(decision.nextVaultId === "vault-new", "decision records the next vaultId");
		assert(decision.hostChanged === false, "host unchanged is reported");
	}
}

console.log("\n--- Test 3: vaultId + host change is still a room-change ---");
{
	const decision = decide({ nextHost: "https://new.example.com", nextVaultId: "vault-new" });
	assert(decision.kind === "room-change", "vaultId dominates the decision");
	if (decision.kind === "room-change") {
		assert(decision.hostChanged === true, "host change is reported alongside");
	}
}

console.log("\n--- Test 4: host-only change keeps baselines ---");
{
	const decision = decide({ nextHost: "https://new.example.com" });
	assert(decision.kind === "host-only", "same vaultId on a new host → host-only");
	if (decision.kind === "host-only") {
		assert(decision.previousHost === "https://old.example.com", "decision records previous host");
		assert(decision.nextHost === "https://new.example.com", "decision records next host");
	}
}

console.log("\n--- Test 5: empty host cannot sync — state is left alone ---");
{
	const bothChanged = decide({ nextHost: "", nextVaultId: "vault-new" });
	assert(bothChanged.kind === "none", "empty next host → none even with a vaultId change");

	const whitespaceHost = decide({ nextHost: "   ", nextVaultId: "vault-new" });
	assert(whitespaceHost.kind === "none", "whitespace-only host → none");
}

console.log("\n--- Test 6: pairing onto a configured host (empty vaultId) is a room-change ---");
{
	const decision = decide({ previousVaultId: "", nextVaultId: "vault-first" });
	assert(decision.kind === "room-change", "host-set + empty→id vaultId is a room change");
}

console.log("\n--- Test 7: initial configuration is not a transition ---");
{
	const decision = decide({ previousHost: "", previousVaultId: "", nextHost: "https://first.example.com", nextVaultId: "vault-first" });
	assert(
		decision.kind === "none",
		"a fully unconfigured device gaining its first identity fires no reset (startup generation path)",
	);
}

console.log("\n--- Test 8: whitespace difference in host alone is a host-only transition ---");
{
	const decision = decide({ nextHost: "https://old.example.com/" });
	assert(decision.kind === "host-only", "trailing-slash host difference → host-only");
}

console.log("\n--- Results ---");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
