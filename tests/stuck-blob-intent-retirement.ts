import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	PendingBlobIntentJournal,
	type PendingBlobIntentScope,
} from "../src/sync/pendingBlobIntentJournal";
import {
	decidePendingBlobIntentRetirement,
	type PendingBlobIntentGroundTruth,
	type PendingBlobIntentRetirementDisposition,
} from "../src/sync/pendingBlobIntentRetirement";
import {
	getPreservedUnresolvedEpisodeId,
	PreservedUnresolvedRegistry,
} from "../src/sync/preservedUnresolved";
import { LEGACY_MISSING_BLOB_ATTENTION_REASON } from "../src/sync/blobSettledRefMigration";

const scope: PendingBlobIntentScope = {
	host: "sync.example",
	vaultId: "vault",
	localDeviceId: "device-a",
};

function dispositionKind(
	disposition: PendingBlobIntentRetirementDisposition,
): string {
	return disposition.kind;
}

console.log("\n--- retirement decision table ---");
{
	const groundTruth = (diskOccupied: boolean, liveRef: boolean): PendingBlobIntentGroundTruth =>
		({ diskOccupied, liveRef });

	// Absence is the settled world state: every intent state retires. The
	// journal entry cannot protect an absence that already exists everywhere.
	for (const state of ["attempted", "committed", "ready"] as const) {
		const journal = new PendingBlobIntentJournal();
		const intent = journal.recordDelete("Notes/handoff.txt", scope, { known: true, ref: undefined });
		if (state === "attempted") {
			assert.equal(
				journal.markCommitAttempted(intent.id, "attempt-1", 1_000, "session-1"),
				true,
			);
		} else if (state === "committed") {
			assert.equal(
				journal.markCommitted(intent.id, 2_000, "session-1"),
				true,
			);
		}
		const current = journal.getEntries(scope)[0];
		assert.equal(
			dispositionKind(decidePendingBlobIntentRetirement(current, groundTruth(false, false))),
			"retire-absence-settled",
			`absence-settled retirement applies to a ${state} intent`,
		);
	}

	// A live CRDT ref owns the path while the disk file is gone: retire with the
	// download-gated handoff so an ungated reconcile cannot resurrect the file.
	{
		const journal = new PendingBlobIntentJournal();
		const intent = journal.recordDelete("Notes/handoff.txt", scope, { known: true, ref: undefined });
		assert.equal(
			dispositionKind(decidePendingBlobIntentRetirement(intent, groundTruth(false, true))),
			"retire-authority-moved",
			"live remote authority with local absence retires via handoff",
		);
	}

	// A dead commit attempt fences a recreated occupant's uploads; retire it.
	{
		const journal = new PendingBlobIntentJournal();
		const intent = journal.recordDelete("Notes/handoff.txt", scope, { known: true, ref: undefined });
		assert.equal(
			journal.markCommitAttempted(intent.id, "attempt-1", 1_000, "session-1"),
			true,
		);
		const current = journal.getEntries(scope)[0];
		assert.equal(
			dispositionKind(decidePendingBlobIntentRetirement(current, groundTruth(true, true))),
			"retire-stale-local-episode",
			"a dead attempt fencing a recreated file retires",
		);
	}

	// An occupant with a live, non-attempted intent keeps today's quarantine:
	// branch D is an operator-resolvable remote-delete-local-conflict.
	for (const state of ["ready", "committed"] as const) {
		const journal = new PendingBlobIntentJournal();
		const intent = journal.recordDelete("Notes/handoff.txt", scope, { known: true, ref: undefined });
		if (state === "committed") {
			assert.equal(journal.markCommitted(intent.id, 2_000, "session-1"), true);
		}
		const current = journal.getEntries(scope)[0];
		for (const liveRef of [true, false]) {
			assert.equal(
				dispositionKind(decidePendingBlobIntentRetirement(current, groundTruth(true, liveRef))),
				"retain",
				`an occupied path with a ${state} intent is retained (liveRef=${liveRef})`,
			);
		}
	}
}

console.log("\n--- retirement applies to journal and attention together ---");
{
	// T1: absence-settled retirement removes the intent and clears the episode.
	const journal = new PendingBlobIntentJournal();
	const intent = journal.recordDelete("Handoff Recovery.txt", scope, { known: true, ref: undefined });
	assert.equal(
		journal.markCommitAttempted(intent.id, "attempt-1", 1_000, "session-1"),
		true,
	);
	const registry = new PreservedUnresolvedRegistry();
	registry.record({
		path: "Handoff Recovery.txt",
		kind: "blob",
		reason: "local-blob-mutation-remote-conflict",
		at: 1_000,
	});
	const current = journal.getEntries(scope)[0];
	const disposition = decidePendingBlobIntentRetirement(current, { diskOccupied: false, liveRef: false });
	assert.equal(dispositionKind(disposition), "retire-absence-settled");
	journal.remove(current.id);
	registry.resolve("Handoff Recovery.txt");
	assert.equal(journal.size, 0, "retirement removes the stuck intent from the journal");
	assert.equal(registry.get("Handoff Recovery.txt"), null, "retirement clears the attention episode");
}

console.log("\n--- authority-moved handoff keeps the download gate ---");
{
	// T2: a live remote authority converts the episode into the legacy-missing
	// attention instead of leaving the path ungated for auto-download.
	const journal = new PendingBlobIntentJournal();
	const intent = journal.recordDelete("Handoff Recovery.txt", scope, { known: true, ref: undefined });
	const registry = new PreservedUnresolvedRegistry();
	registry.record({
		path: "Handoff Recovery.txt",
		kind: "blob",
		reason: "local-blob-mutation-remote-conflict",
		at: 1_000,
	});
	const disposition = decidePendingBlobIntentRetirement(intent, { diskOccupied: false, liveRef: true });
	assert.equal(dispositionKind(disposition), "retire-authority-moved");
	journal.remove(intent.id);
	registry.resolve("Handoff Recovery.txt");
	registry.record({
		path: "Handoff Recovery.txt",
		kind: "blob",
		reason: LEGACY_MISSING_BLOB_ATTENTION_REASON,
		at: 2_000,
	});
	const handedOff = registry.get("Handoff Recovery.txt");
	assert.equal(journal.size, 0, "the lost local intent is retired");
	assert.equal(
		handedOff?.reason,
		"legacy-upgrade-missing-local-blob",
		"the handoff surfaces the standard download-or-keep-absence attention",
	);
}

console.log("\n--- rename retirement clears both namespaces ---");
{
	const journal = new PendingBlobIntentJournal();
	const intent = journal.recordRename("old.txt", "new.txt", scope, { known: true, ref: undefined });
	assert.ok(intent, "rename intent is journaled");
	const registry = new PreservedUnresolvedRegistry();
	registry.record({ path: "old.txt", kind: "blob", reason: "local-blob-mutation-remote-conflict", at: 1_000 });
	registry.record({ path: "new.txt", kind: "blob", reason: "local-blob-mutation-remote-conflict", at: 1_000 });
	const disposition = decidePendingBlobIntentRetirement(intent, { diskOccupied: false, liveRef: false });
	assert.equal(dispositionKind(disposition), "retire-absence-settled");
	journal.remove(intent.id);
	registry.resolve("old.txt");
	registry.resolve("new.txt");
	assert.equal(journal.size, 0);
	assert.equal(registry.get("old.txt"), null, "rename retirement clears the source attention");
	assert.equal(registry.get("new.txt"), null, "rename retirement clears the destination attention");
}

console.log("\n--- re-recording refreshes lastSeenAt (why the guard exists) ---");
{
	// T4: without an idempotence guard, each status tick continues the same
	// episode and refreshes lastSeenAt forever. The replay call site must skip
	// re-recording while the identical path+kind+reason episode is present.
	const registry = new PreservedUnresolvedRegistry();
	registry.record({
		path: "Handoff Recovery.txt",
		kind: "blob",
		reason: "local-blob-mutation-remote-conflict",
		at: 1_000,
	});
	const first = registry.get("Handoff Recovery.txt");
	const firstEpisodeId = getPreservedUnresolvedEpisodeId(first!);
	registry.record({
		path: "Handoff Recovery.txt",
		kind: "blob",
		reason: "local-blob-mutation-remote-conflict",
		at: 502_000,
	});
	const second = registry.get("Handoff Recovery.txt");
	assert.equal(
		getPreservedUnresolvedEpisodeId(second!),
		firstEpisodeId,
		"a same-reason re-record continues the episode",
	);
	assert.equal(second!.firstSeenAt, first!.firstSeenAt, "firstSeenAt is episode-stable");
	assert.equal(second!.lastSeenAt, 502_000, "lastSeenAt refreshes on every re-record without a guard");
}

console.log("\n--- main.ts retirement wiring ---");
{
	const main = readFileSync("src/main.ts", "utf8");

	const retireOrDef = main.indexOf("private async retireOrQuarantinePendingBlobIntent(");
	const retireStuckDef = main.indexOf("private async retireStuckBlobEpisode(");
	assert(retireOrDef >= 0 && retireStuckDef >= 0, "retirement methods exist");

	// Every previously-unconditional conflict site in the replay loop now runs
	// the retirement decision first: 3 fence branches, delete occupant +
	// prepare-fail + postcondition-else, and their rename equivalents.
	const replayStart = main.indexOf("private async replayPendingBlobIntentsOnce(");
	const replayEnd = main.indexOf("private async openDashboard(", replayStart);
	const replayBody = main.slice(replayStart, replayEnd);
	const retireCalls = replayBody.split("retireOrQuarantinePendingBlobIntent(").length - 1;
	assert.equal(
		retireCalls,
		9,
		"all nine replay-loop conflict sites run the retirement decision",
	);

	// The attempted fence still precedes every retire decision in the loop, so
	// a dead attempt is identified as such before anything is forgotten.
	const attemptedFence = replayBody.indexOf("if (intent.commitAttemptId !== undefined) {");
	assert(
		attemptedFence >= 0
			&& attemptedFence < replayBody.indexOf("retireOrQuarantinePendingBlobIntent("),
		"the durable attempted fence still runs before any retirement",
	);

	// Normal receipt waiting is untouched: the postcondition-true branch keeps
	// its replayed marker and never retires.
	const committedBranch = replayBody.indexOf(
		"if (this.hasPendingBlobIntentCommitPostcondition(intent, vaultSync)) {\n\t\t\t\t\t\tthis.replayedCommittedBlobIntentIds.add(intent.id);",
	);
	assert(
		committedBranch >= 0,
		"a committed intent with a satisfiable postcondition still waits for its receipt",
	);

	// Idempotent quarantine: the conflict recorder skips while the identical
	// episode is already recorded, so ticks neither refresh lastSeenAt nor
	// re-fence transfers.
	const recorderStart = main.indexOf("private recordCommittedBlobIntentConflict(");
	const recorderEnd = main.indexOf("private clearResolvedLocalBlobMutationConflict(", recorderStart);
	const recorder = main.slice(recorderStart, recorderEnd);
	assert(recorder.includes("alreadyRecorded"), "the conflict recorder is idempotent per episode");
	assert(
		recorder.indexOf("alreadyRecorded") < recorder.indexOf("recordPreservedUnresolved(path, reason)")
			&& recorder.indexOf("alreadyRecorded") < recorder.indexOf("recordPersistedBlobUnresolved(path, reason)"),
		"the guard precedes both record paths",
	);

	// Resolution clears both intent-episode conflict reasons, so a resolved
	// remote-delete-local-conflict cannot linger as dashboard noise.
	const clearStart = recorderEnd;
	const clearEnd = main.indexOf("private pendingBlobIntentGroundTruth(", clearStart);
	const clearBody = main.slice(clearStart, clearEnd);
	assert(
		clearBody.includes("isIntentEpisodeConflictReason(entry.reason)"),
		"intent resolution clears every intent-episode conflict reason",
	);
	const reasonsConst = main.slice(main.indexOf("INTENT_EPISODE_CONFLICT_REASONS"));
	assert(
		reasonsConst.includes("\"local-blob-mutation-remote-conflict\"")
			&& reasonsConst.includes("\"remote-delete-local-conflict\""),
		"both intent-episode conflict reasons are covered",
	);

	// Retirement forgets only settlement stages installed by the retiring
	// intent's own removal prep; random-id retire stages are compact absence
	// provenance and must survive.
	const retireBody = main.slice(retireStuckDef, main.indexOf("private applyPendingBlobDelete(", retireStuckDef));
	assert(
		retireBody.includes("`committed:${intent.id}`") && retireBody.includes("`rename:${intent.id}`"),
		"only owned settlement stages are deleted on retirement",
	);
	assert(
		retireBody.indexOf("retire-authority-moved") >= 0
			&& retireBody.indexOf("LEGACY_MISSING_BLOB_ATTENTION_REASON") > retireBody.indexOf("retire-authority-moved"),
		"authority-moved retirement hands off to the download-gated attention",
	);
	assert(
		retireBody.includes('"pending-blob-intent-retired"'),
		"every retirement is recorded as a trace",
	);

	// Operator dismissal routes through the same retirement routine with an
	// episode gate and the same live-ref handoff safety.
	const dismissStart = main.indexOf("private async dismissStuckLocalMutationAttention(");
	const dismissEnd = main.indexOf("private getCurrentLegacyMissingBlobAttention(", dismissStart);
	const dismissBody = main.slice(dismissStart, dismissEnd);
	assert(dismissStart >= 0, "the operator dismiss action exists");
	assert(
		dismissBody.includes('current.reason !== "local-blob-mutation-remote-conflict"')
			&& dismissBody.includes("getPreservedUnresolvedEpisodeId(current) !== target.episodeId"),
		"dismissal is gated on the exact live episode",
	);
	assert(
		dismissBody.includes("{ kind: \"retire-authority-moved\" }") && dismissBody.includes('"operator"'),
		"dismissal keeps the live-ref handoff and traces its origin",
	);
}

console.log("\n--- hydration migration drops abolished blob episodes ---");
{
	const main = readFileSync("src/main.ts", "utf8");
	const filterStart = main.indexOf("if (Array.isArray(data?._preservedUnresolved)) {");
	const filterEnd = main.indexOf("const cachedCapabilities", filterStart);
	const filterBody = main.slice(filterStart, filterEnd);
	assert(
		filterBody.includes('candidate.kind === "blob"')
			&& filterBody.indexOf('candidate.reason === "local-blob-mutation-remote-conflict"') > 0,
		"hydration drops structurally unresolvable local-mutation blob episodes",
	);
	assert(
		!filterBody.includes('candidate.reason === "remote-delete-local-conflict"'),
		"operator-resolvable remote-delete limbo reasons are not dropped",
	);
	assert(
		filterBody.includes("droppedPreservedUnresolved = true"),
		"dropping entries marks the state for immediate persistence",
	);
	assert(
		main.includes("migrated || scrubbedBlobQueue || droppedPreservedUnresolved"),
		"dropped preserved episodes persist on load instead of lingering in data.json",
	);
}

console.log("\n--- dashboard dismissal action ---");
{
	const view = readFileSync("src/dashboard/KaosDashboardView.ts", "utf8");
	assert(
		view.includes("dismissStuckLocalMutationAttention") && view.includes("Dismiss (trace-only)"),
		"the dashboard renders a trace-only dismissal for stuck local-mutation conflicts",
	);
	const types = readFileSync("src/dashboard/dashboardTypes.ts", "utf8");
	assert(
		types.includes("DashboardStuckLocalMutationResolution"),
		"the dismissal target is a typed dashboard resolution",
	);
	const data = readFileSync("src/dashboard/dashboardData.ts", "utf8");
	assert(
		data.includes('entry.reason === "local-blob-mutation-remote-conflict"')
			&& data.includes("stuckLocalMutationResolution"),
		"attention rows for stuck local-mutation conflicts carry the dismissal resolution",
	);
	const main = readFileSync("src/main.ts", "utf8");
	assert(
		main.includes("dismissStuckLocalMutationAttention: (target) =>"),
		"the dismissal action is wired into the dashboard",
	);
}

console.log("\nAll stuck blob intent retirement checks passed.");
