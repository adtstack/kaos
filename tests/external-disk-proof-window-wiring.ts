import { readFileSync } from "node:fs";

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

const source = readFileSync("src/sync/editorBinding.ts", "utf8");

console.log("\n--- Test 1: host-projection proof window is a separate, longer constant ---");
{
	assert(
		source.includes("const EXTERNAL_DISK_HOST_PROJECTION_PROOF_MS = 15_000;"),
		"EXTERNAL_DISK_HOST_PROJECTION_PROOF_MS = 15_000 is defined",
	);
	assert(
		source.includes("const EXTERNAL_DISK_RELOAD_CORRELATION_MS = 5000;"),
		"generic correlation window stays at 5000ms",
	);
}

console.log("\n--- Test 2: proof and promotion use the proof window, generic markers keep 5s ---");
{
	const proofUsages = source.split("> EXTERNAL_DISK_HOST_PROJECTION_PROOF_MS").length - 1;
	assert(
		proofUsages >= 2,
		`proof freshness + held promotion use the proof window (${proofUsages} sites)`,
	);
	const resolveStart = source.indexOf("private resolveExternalDiskHostProjectionProof");
	const resolveSource = resolveStart >= 0 ? source.slice(resolveStart, resolveStart + 700) : "";
	assert(
		resolveSource.includes("EXTERNAL_DISK_HOST_PROJECTION_PROOF_MS"),
		"resolveExternalDiskHostProjectionProof checks the proof window",
	);
	const promoteStart = source.indexOf("private promoteHeldExternalDiskHostProjection");
	const promoteSource = promoteStart >= 0 ? source.slice(promoteStart, promoteStart + 700) : "";
	assert(
		promoteSource.includes("EXTERNAL_DISK_HOST_PROJECTION_PROOF_MS"),
		"promoteHeldExternalDiskHostProjection checks the proof window",
	);
	const freshStart = source.indexOf("private getFreshPendingExternalDiskMutation");
	const freshSource = freshStart >= 0 ? source.slice(freshStart, freshStart + 500) : "";
	assert(
		freshSource.includes("EXTERNAL_DISK_RELOAD_CORRELATION_MS"),
		"generic pending-marker freshness keeps the 5s correlation window",
	);
}

console.log("\n--- Test 3: uncorrelated host set leaves an audit breadcrumb ---");
{
	assert(
		source.includes('"external-disk-host-set-uncorrelated-pass"'),
		"uncorrelated host-set pass emits its trace",
	);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
