/**
 * Unit tests for the DiscardedRevisionAudit client: debounced batching,
 * path hashing (no raw vault path in the payload), batch-cap immediate
 * flush, settings guard, and fail-silent transport.
 */

import {
	AUDIT_MAX_BATCH,
	DiscardedRevisionAudit,
	type DiscardedRevisionRecord,
} from "../src/runtime/discardedRevisionAudit";

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

function makeDeps(overrides: {
	settings?: { host: string; authorizationHeader?: () => Promise<string>; vaultId: string };
	postJson?: (url: string, body: unknown) => Promise<{ ok: boolean }>;
} = {}) {
	const posts: Array<{ url: string; body: unknown }> = [];
	return {
		deps: {
			getSettings: () => overrides.settings ?? { host: "https://kaos.example", authorizationHeader: async () => "Bearer ephemeral-session", vaultId: "vault-a" },
			postJson: overrides.postJson ?? (async (url, body) => {
				posts.push({ url, body });
				return { ok: true };
			}),
		},
		posts,
	};
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log("\n--- Test 1: records are debounced into one batched POST ---");
{
	const { deps, posts } = makeDeps();
	const audit = new DiscardedRevisionAudit(deps, { flushDelayMs: 5 });
	audit.record("NOTES/note.md", "hash-1", "superseded-external-revision");
	audit.record("NOTES/note.md", "hash-2", "ambiguous-divergence");
	await wait(30);
	await audit.flushNow();

	assert(posts.length === 1, "burst of records flushes as exactly one POST");
	const body = posts[0]!.body as { event?: unknown; data?: { records?: DiscardedRevisionRecord[] } };
	assert(body.event === "revision.discarded", "POST event is revision.discarded");
	assert(body.data?.records?.length === 2, "POST carries both records");
	const first = body.data!.records![0]!;
	assert(first.contentHash === "hash-1", "record carries the content hash");
	assert(first.pathHash.includes(":") && !first.pathHash.includes("note.md"), "record carries a hashed path, never the raw path");
	assert(typeof first.ts === "string" && first.ts.length > 0, "record carries an ISO timestamp");
}

console.log("\n--- Test 2: batch cap flushes immediately without waiting ---");
{
	const { deps, posts } = makeDeps();
	const audit = new DiscardedRevisionAudit(deps, { flushDelayMs: 10_000 });
	for (let i = 0; i < AUDIT_MAX_BATCH; i++) {
		audit.record("NOTES/batch.md", `hash-${i}`, "superseded-external-revision");
	}
	assert(posts.length === 1, "reaching the batch cap flushes immediately");
	const body = posts[0]!.body as { data?: { records?: DiscardedRevisionRecord[] } };
	assert(body.data?.records?.length === AUDIT_MAX_BATCH, "batch POST carries exactly the cap-sized batch");
	await audit.flushNow();
	assert(posts.length === 1, "empty queue after batch flush produces no extra POST");
}

console.log("\n--- Test 3: missing settings skips the POST silently ---");
{
	const { deps, posts } = makeDeps({ settings: { host: "", vaultId: "" } });
	const audit = new DiscardedRevisionAudit(deps, { flushDelayMs: 5 });
	audit.record("NOTES/note.md", "hash-1", "superseded-external-revision");
	await wait(15);
	await audit.flushNow();
	assert(posts.length === 0, "no POST is attempted without host/device session/vaultId");
}

console.log("\n--- Test 4: transport failure is silent and does not block later records ---");
{
	let failFirst = true;
	const { deps, posts } = makeDeps({
		postJson: async (url, body) => {
			if (failFirst) {
				failFirst = false;
				throw new Error("network down");
			}
			posts.push({ url, body });
			return { ok: true };
		},
	});
	const audit = new DiscardedRevisionAudit(deps, { flushDelayMs: 5 });
	audit.record("NOTES/a.md", "hash-a", "superseded-external-revision");
	await wait(15);
	await audit.flushNow();
	assert(posts.length === 0, "failed transport is silent (no throw, no retry)");
	audit.record("NOTES/b.md", "hash-b", "ambiguous-divergence");
	await wait(15);
	await audit.flushNow();
	assert(posts.length === 1, "later records still flush after a failure");
}

console.log("\n--- Test 5: flushNow drains the queue and clears the pending timer ---");
{
	const { deps, posts } = makeDeps();
	const audit = new DiscardedRevisionAudit(deps, { flushDelayMs: 60_000 });
	audit.record("NOTES/note.md", "hash-1", "superseded-external-revision");
	await audit.flushNow();
	assert(posts.length === 1, "flushNow posts immediately without waiting for the debounce");
	await wait(10);
	assert(posts.length === 1, "the cancelled timer does not double-post after flushNow");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
