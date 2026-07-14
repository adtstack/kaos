import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessApp } from "../src/headless-host/core/app";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const root = await mkdtemp(join(tmpdir(), "kaos-headless-baselines-"));

try {
	const dataFile = join(root, "state", "data.json");
	const app = new HeadlessApp({ vaultRoot: join(root, "vault"), dataFile });
	const repository = app.baselineTextRepositoryFor("kaos", "vault-a");

	console.log("\n--- headless baseline repository: atomic sidecar persistence ---");
	await repository.save({ [HASH_A]: "alpha\n", [HASH_B]: "" });
	assert.deepEqual(await repository.load([HASH_A, HASH_B]), { [HASH_A]: "alpha\n", [HASH_B]: "" });
	assert.equal(app.baselineTextRepositoryFor("kaos", "vault-a"), repository);
	assert.match(repository.rootDir, /data\.json\.d/);
	assert.deepEqual((await readdir(repository.rootDir)).sort(), [HASH_A, HASH_B]);
	console.log("  PASS  headless baselines live beside, not inside, data.json");

	console.log("\n--- headless baseline repository: reference garbage collection ---");
	await repository.retain([HASH_B]);
	assert.deepEqual(await repository.load([HASH_A, HASH_B]), { [HASH_B]: "" });
	await repository.remove([HASH_B]);
	assert.deepEqual(await repository.load([HASH_B]), {});
	console.log("  PASS  unreferenced sidecar bodies are removed");
} finally {
	await rm(root, { recursive: true, force: true });
}
