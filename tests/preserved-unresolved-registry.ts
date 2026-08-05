import assert from "node:assert/strict";
import { PreservedUnresolvedRegistry, type PreservedUnresolvedEntry } from "../src/sync/preservedUnresolved";

const firstSeenAt = Date.parse("2026-05-11T08:00:00Z");
const lastSeenAt = Date.parse("2026-05-11T08:05:00Z");

const persisted: PreservedUnresolvedEntry[] = [
	{
		path: "Notes/Needs Attention.md",
		kind: "markdown",
		reason: "remote-delete-missing-baseline",
		firstSeenAt,
		lastSeenAt,
		localHash: "local-note",
		knownRemoteHash: null,
	},
	{
		path: "Attachments/photo.png",
		kind: "blob",
		reason: "remote-delete-hash-read-failed",
		firstSeenAt: firstSeenAt + 1,
		lastSeenAt: lastSeenAt + 1,
		localHash: null,
		knownRemoteHash: "remote-blob",
	},
];

const registry = new PreservedUnresolvedRegistry(persisted);

const initialMarkdownEpisode = registry.get("Notes/Needs Attention.md")?.episodeId;
assert.ok(initialMarkdownEpisode, "legacy persisted entries are hydrated with an episode ID");

assert.equal(registry.has("Notes/Needs Attention.md"), true);
assert.equal(registry.paths.has("Notes/Needs Attention.md"), true);
assert.equal(registry.has("Attachments/photo.png"), true);
assert.equal(registry.paths.has("Attachments/photo.png"), true);

const summary = registry.getSummary();
assert.equal(summary.markdownCount, 1);
assert.equal(summary.blobCount, 1);
assert.equal(summary.totalCount, 2);
assert.equal(summary.lastAt, lastSeenAt + 1);
assert.equal(summary.reasons["remote-delete-missing-baseline"], 1);
assert.equal(summary.reasons["remote-delete-hash-read-failed"], 1);

registry.record({
	path: "Notes/Needs Attention.md",
	kind: "markdown",
	reason: "remote-delete-missing-baseline",
	at: lastSeenAt + 5,
});
assert.equal(
	registry.get("Notes/Needs Attention.md")?.episodeId,
	initialMarkdownEpisode,
	"repeated observations retain the same episode ID",
);

registry.record({
	path: "Notes/Needs Attention.md",
	kind: "markdown",
	reason: "remote-delete-missing-baseline",
	episodeId: "replacement-delete-fingerprint",
	at: lastSeenAt + 6,
});
assert.equal(
	registry.get("Notes/Needs Attention.md")?.episodeId,
	"replacement-delete-fingerprint",
	"an explicit new delete fingerprint starts a new episode even when the reason is unchanged",
);

registry.record({
	path: "Notes/Needs Attention.md",
	kind: "markdown",
	reason: "multiple-editor-authorities",
	at: lastSeenAt + 10,
	localHash: "local-note-new",
});

const updated = registry.get("Notes/Needs Attention.md");
assert.ok(updated);
assert.equal(updated.firstSeenAt, lastSeenAt + 10);
assert.equal(updated.lastSeenAt, lastSeenAt + 10);
assert.equal(updated.reason, "multiple-editor-authorities");
assert.notEqual(updated.episodeId, "replacement-delete-fingerprint", "a changed condition starts a new episode");
assert.equal(updated.localHash, "local-note-new");
assert.equal(updated.knownRemoteHash, null);

assert.equal(registry.resolve("Notes/Needs Attention.md"), true);
assert.equal(registry.has("Notes/Needs Attention.md"), false);
assert.equal(registry.paths.has("Notes/Needs Attention.md"), false);
assert.equal(registry.getSummary().totalCount, 1);

registry.clear();
assert.equal(registry.getSummary().totalCount, 0);
assert.equal(registry.paths.size, 0);

const renameSourcePath = "Notes/Before Rename.md";
const renameTargetPath = "Notes/After Rename.md";
const renameSource: PreservedUnresolvedEntry = {
	path: renameSourcePath,
	kind: "markdown",
	reason: "conflict-winner-flush-deferred",
	episodeId: "episode-follow-the-file",
	firstSeenAt: firstSeenAt + 20,
	lastSeenAt: lastSeenAt + 20,
	localHash: "rename-local-hash",
	knownRemoteHash: "rename-remote-hash",
};
const renameRegistry = new PreservedUnresolvedRegistry([renameSource]);
const moved = renameRegistry.move(renameSourcePath, renameTargetPath);
assert.deepEqual(moved, {
	kind: "moved",
	entry: { ...renameSource, path: renameTargetPath },
});
assert.equal(renameRegistry.has(renameSourcePath), false);
assert.equal(renameRegistry.paths.has(renameSourcePath), false);
assert.deepEqual(
	renameRegistry.get(renameTargetPath),
	{ ...renameSource, path: renameTargetPath },
	"a rename preserves the complete unresolved episode and changes only its path",
);

const collisionSource: PreservedUnresolvedEntry = {
	...renameSource,
	path: "Notes/Collision Source.md",
	episodeId: "source-episode",
};
const collisionTarget: PreservedUnresolvedEntry = {
	...renameSource,
	path: "Notes/Collision Target.md",
	reason: "three-way-preserve-failed",
	episodeId: "target-episode",
	firstSeenAt: firstSeenAt + 30,
	lastSeenAt: lastSeenAt + 30,
	localHash: "target-local-hash",
	knownRemoteHash: null,
};
const collisionRegistry = new PreservedUnresolvedRegistry([
	collisionSource,
	collisionTarget,
]);
const collision = collisionRegistry.move(collisionSource.path, collisionTarget.path);
assert.equal(collision.kind, "collision");
assert.deepEqual(collisionRegistry.get(collisionSource.path), collisionSource);
assert.deepEqual(collisionRegistry.get(collisionTarget.path), collisionTarget);

const episodeRegistry = new PreservedUnresolvedRegistry([{
	path: "Attachments/episode.png",
	kind: "blob",
	reason: "remote-download-local-conflict",
	episodeId: "remote-episode-1",
	firstSeenAt,
	lastSeenAt,
	localHash: "a".repeat(64),
	knownRemoteHash: "b".repeat(64),
	artifactPath: "Attachments/episode (KAOS remote conflict old).png",
	knownRemoteRefFingerprint: "old-ref",
	knownRemoteSourceVersion: "1:2",
}]);
episodeRegistry.record({
	path: "Attachments/episode.png",
	kind: "blob",
	reason: "remote-download-local-conflict",
	episodeId: "remote-episode-2",
	localHash: null,
	knownRemoteHash: "c".repeat(64),
	artifactPath: null,
	knownRemoteRefFingerprint: null,
	knownRemoteSourceVersion: null,
	at: lastSeenAt + 40,
});
assert.deepEqual(
	{
		artifactPath: episodeRegistry.get("Attachments/episode.png")?.artifactPath,
		knownRemoteRefFingerprint: episodeRegistry.get("Attachments/episode.png")?.knownRemoteRefFingerprint,
		knownRemoteSourceVersion: episodeRegistry.get("Attachments/episode.png")?.knownRemoteSourceVersion,
	},
	{
		artifactPath: null,
		knownRemoteRefFingerprint: null,
		knownRemoteSourceVersion: null,
	},
	"a new conflict episode never inherits candidate authority from the previous episode",
);

const exactResolutionPath = "Notes/exact-resolution.md";
const exactResolutionRegistry = new PreservedUnresolvedRegistry([{
	path: exactResolutionPath,
	kind: "markdown",
	reason: "external-disk-read-unavailable",
	episodeId: "exhausted-read-episode",
	firstSeenAt,
	lastSeenAt,
}]);
assert.equal(
	exactResolutionRegistry.resolveEpisode(exactResolutionPath, "older-episode"),
	false,
	"an older owner cannot resolve a same-path replacement episode",
);
assert.equal(
	exactResolutionRegistry.get(exactResolutionPath)?.episodeId,
	"exhausted-read-episode",
	"failed exact resolution leaves the current episode intact",
);
assert.equal(
	exactResolutionRegistry.resolveEpisode(exactResolutionPath, "exhausted-read-episode"),
	true,
	"the exact exhausted-read owner can resolve its episode",
);
assert.equal(exactResolutionRegistry.has(exactResolutionPath), false);
assert.equal(exactResolutionRegistry.paths.has(exactResolutionPath), false);

console.log("preserved-unresolved registry tests passed");
