import assert from "node:assert/strict";
import {
	auditAttentionEntries,
	classifyMarkdownRetirementSettlement,
	isArchivePath,
} from "../src/dashboard/attentionAudit";
import {
	createPreservedUnresolvedEpisodeId,
	getPreservedUnresolvedEpisodeId,
	PreservedUnresolvedRegistry,
	type PreservedUnresolvedEntry,
} from "../src/sync/preservedUnresolved";

import { TFile, TFolder } from "obsidian";

// Mock Vault & File classes for Obsidian testing
class MockTFile extends TFile {
	constructor(
		public path: string,
		public stat = { mtime: 1000, size: 50 },
	) {
		super();
	}
}

class MockTFolder extends TFolder {
	constructor(public path: string) {
		super();
	}
}

class MockVault {
	private files = new Map<string, MockTFile | MockTFolder>();

	addFile(path: string, mtime = 1000, size = 50): MockTFile {
		const file = new MockTFile(path, { mtime, size });
		this.files.set(path, file);
		return file;
	}

	addFolder(path: string): MockTFolder {
		const folder = new MockTFolder(path);
		this.files.set(path, folder);
		return folder;
	}

	remove(path: string): void {
		this.files.delete(path);
	}

	getAbstractFileByPath(path: string): unknown {
		return this.files.get(path) ?? null;
	}

	getFiles(): MockTFile[] {
		return Array.from(this.files.values()).filter((f): f is MockTFile => f instanceof MockTFile);
	}
}

console.log("\n--- PreservedUnresolvedRegistry resolveEpisode ---");
{
	const registry = new PreservedUnresolvedRegistry();
	const ep1 = createPreservedUnresolvedEpisodeId(1000);
	registry.record({
		path: "notes/sample.md",
		kind: "markdown",
		reason: "remote-delete-missing-baseline",
		episodeId: ep1,
		at: 1000,
	});

	assert.equal(registry.has("notes/sample.md"), true, "entry recorded");
	assert.equal(
		registry.resolveEpisode("notes/sample.md", "wrong-episode-id"),
		false,
		"resolveEpisode rejects mismatched episodeId",
	);
	assert.equal(registry.has("notes/sample.md"), true, "entry remains after rejected resolveEpisode");

	assert.equal(
		registry.resolveEpisode("notes/sample.md", ep1),
		true,
		"resolveEpisode succeeds with matching episodeId",
	);
	assert.equal(registry.has("notes/sample.md"), false, "entry removed after valid resolveEpisode");

	// ABA protection test: new episode on same path
	const ep2 = createPreservedUnresolvedEpisodeId(2000);
	registry.record({
		path: "notes/sample.md",
		kind: "markdown",
		reason: "remote-delete-missing-baseline",
		episodeId: ep2,
		at: 2000,
	});

	assert.equal(
		registry.resolveEpisode("notes/sample.md", ep1),
		false,
		"stale episodeId cannot remove newer episode (ABA protected)",
	);
	assert.equal(registry.has("notes/sample.md"), true, "newer episode preserved");
	assert.equal(registry.resolveEpisode("notes/sample.md", ep2), true, "newer episode resolved");
	assert.equal(registry.has("notes/sample.md"), false, "registry empty");
}

console.log("\n--- isArchivePath helper ---");
{
	assert.equal(isArchivePath("Archive/2026/note.md"), true);
	assert.equal(isArchivePath("notes/archive/note.md"), true);
	assert.equal(isArchivePath("_archive/note.md"), true);
	assert.equal(isArchivePath("notes/active-note.md"), false);
}

console.log("\n--- Attention Audit: conflict-winner-flush-deferred is NEVER retirable ---");
{
	const vault = new MockVault();
	const entry: PreservedUnresolvedEntry = {
		path: "notes/daily.md",
		kind: "markdown",
		reason: "conflict-winner-flush-deferred",
		firstSeenAt: 1000,
		lastSeenAt: 1000,
		episodeId: "cwfd-ep-1",
	};

	const audit = auditAttentionEntries({
		vault,
		preservedUnresolvedEntries: [entry],
	});

	assert.equal(audit.items.length, 1);
	assert.equal(audit.items[0].classification, "active");
	assert.equal(audit.summary.activeCount, 1);
	assert.equal(audit.summary.retirableCount, 0);
	assert.match(audit.items[0].rationale, /conflict-winner-flush-deferred/);
}

console.log("\n--- Attention Audit: Remote Delete classifications ---");
{
	const vault = new MockVault();
	const entryAbsent: PreservedUnresolvedEntry = {
		path: "notes/deleted-remote.md",
		kind: "markdown",
		reason: "remote-delete-missing-baseline",
		firstSeenAt: 1000,
		lastSeenAt: 1000,
		episodeId: "rd-ep-1",
	};

	const entryExisting: PreservedUnresolvedEntry = {
		path: "notes/kept-locally.md",
		kind: "markdown",
		reason: "remote-delete-missing-baseline",
		firstSeenAt: 1000,
		lastSeenAt: 1000,
		episodeId: "rd-ep-2",
	};
	vault.addFile("notes/kept-locally.md");

	// 1. Online: absent file is retirable, existing file is active
	const auditOnline = auditAttentionEntries({
		vault,
		preservedUnresolvedEntries: [entryAbsent, entryExisting],
		remoteDeleteResolutionState: {
			markdownAvailable: true,
			blobAvailable: true,
			getFingerprint: () => "fp-123",
			isKeepLocalPending: () => false,
			getBlobRef: () => null,
		},
	});

	assert.equal(auditOnline.summary.retirableCount, 1);
	assert.equal(auditOnline.summary.activeCount, 1);
	assert.equal(auditOnline.summary.needsReviewCount, 0);

	const absentItem = auditOnline.items.find((i) => i.entry.path === "notes/deleted-remote.md");
	assert.equal(absentItem?.classification, "retirable");
	assert.equal(absentItem?.remoteDeleteFingerprint, "fp-123");

	const existingItem = auditOnline.items.find((i) => i.entry.path === "notes/kept-locally.md");
	assert.equal(existingItem?.classification, "active");

	// 2. Offline / sync unavailable: absent file becomes needs-review
	const auditOffline = auditAttentionEntries({
		vault,
		preservedUnresolvedEntries: [entryAbsent, entryExisting],
		remoteDeleteResolutionState: {
			markdownAvailable: false,
			blobAvailable: false,
			getFingerprint: () => null,
			isKeepLocalPending: () => false,
			getBlobRef: () => null,
		},
	});

	assert.equal(auditOffline.summary.retirableCount, 0, "offline cannot retire remote deletes");
	assert.equal(auditOffline.summary.needsReviewCount, 1, "absent becomes needs-review offline");
	assert.equal(auditOffline.summary.activeCount, 1, "existing file remains active");
}

console.log("\n--- Attention Audit: Path Collision Archive Pair ---");
{
	const vault = new MockVault();
	vault.addFile("Archive/2026/OldProject.md"); // destination exists

	const sourceEntry: PreservedUnresolvedEntry = {
		path: "Projects/OldProject.md",
		kind: "markdown",
		reason: "path-collision",
		firstSeenAt: 1000,
		lastSeenAt: 1000,
		episodeId: "coll-ep-src",
	};

	const targetEntry: PreservedUnresolvedEntry = {
		path: "Archive/2026/OldProject.md",
		kind: "markdown",
		reason: "path-collision",
		firstSeenAt: 1000,
		lastSeenAt: 1000,
		episodeId: "coll-ep-dst",
	};

	const audit = auditAttentionEntries({
		vault,
		preservedUnresolvedEntries: [sourceEntry, targetEntry],
		remoteDeleteResolutionState: {
			markdownAvailable: true,
			blobAvailable: true,
			getFingerprint: () => null,
			isKeepLocalPending: () => false,
			getBlobRef: () => null,
		},
	});

	assert.equal(audit.summary.retirableCount, 2, "both endpoints of archive move are retirable");
	assert.equal(audit.summary.activeCount, 0);
	assert.equal(audit.summary.needsReviewCount, 0);

	const srcItem = audit.items.find((i) => i.entry.path === "Projects/OldProject.md");
	assert.equal(srcItem?.classification, "retirable");
	assert.equal(srcItem?.pairPath, "Archive/2026/OldProject.md");

	const dstItem = audit.items.find((i) => i.entry.path === "Archive/2026/OldProject.md");
	assert.equal(dstItem?.classification, "retirable");
	assert.equal(dstItem?.pairPath, "Projects/OldProject.md");

	// Test incomplete archive pair (target also missing)
	vault.remove("Archive/2026/OldProject.md");
	const auditIncomplete = auditAttentionEntries({
		vault,
		preservedUnresolvedEntries: [sourceEntry, targetEntry],
		remoteDeleteResolutionState: {
			markdownAvailable: true,
			blobAvailable: true,
			getFingerprint: () => null,
			isKeepLocalPending: () => false,
			getBlobRef: () => null,
		},
	});

	assert.equal(auditIncomplete.summary.retirableCount, 0);
	assert.equal(auditIncomplete.summary.needsReviewCount, 2, "incomplete archive pair needs review");
}

console.log("\n--- Attention Audit: Legacy Missing Blob & Stuck Local Mutation ---");
{
	const vault = new MockVault();

	const legacyMissingNoRemote: PreservedUnresolvedEntry = {
		path: "attachments/old-image.png",
		kind: "blob",
		reason: "legacy-upgrade-missing-local-blob",
		firstSeenAt: 1000,
		lastSeenAt: 1000,
		episodeId: "legacy-ep-1",
	};

	const legacyMissingWithRemote: PreservedUnresolvedEntry = {
		path: "attachments/downloadable.png",
		kind: "blob",
		reason: "legacy-upgrade-missing-local-blob",
		firstSeenAt: 1000,
		lastSeenAt: 1000,
		episodeId: "legacy-ep-2",
	};

	const stuckMutationAbsent: PreservedUnresolvedEntry = {
		path: "attachments/stuck-deleted.png",
		kind: "blob",
		reason: "local-blob-mutation-remote-conflict",
		firstSeenAt: 1000,
		lastSeenAt: 1000,
		episodeId: "stuck-ep-1",
	};

	const audit = auditAttentionEntries({
		vault,
		preservedUnresolvedEntries: [
			legacyMissingNoRemote,
			legacyMissingWithRemote,
			stuckMutationAbsent,
		],
		remoteDeleteResolutionState: {
			markdownAvailable: true,
			blobAvailable: true,
			getFingerprint: () => null,
			isKeepLocalPending: () => false,
			getBlobRef: (path) => path === "attachments/downloadable.png"
				? { fileId: "fid", contentHash: "h1", size: 100 }
				: null,
		},
	});

	assert.equal(audit.summary.retirableCount, 2);
	assert.equal(audit.summary.activeCount, 1, "downloadable blob is active");

	const downloadable = audit.items.find((i) => i.entry.path === "attachments/downloadable.png");
	assert.equal(downloadable?.classification, "active");

	const noRemote = audit.items.find((i) => i.entry.path === "attachments/old-image.png");
	assert.equal(noRemote?.classification, "retirable");

	const stuck = audit.items.find((i) => i.entry.path === "attachments/stuck-deleted.png");
	assert.equal(stuck?.classification, "retirable");
}

console.log("\n--- Attention Audit: Read-only invariant ---");
{
	const vault = new MockVault();
	const entries: PreservedUnresolvedEntry[] = [
		{
			path: "notes/a.md",
			kind: "markdown",
			reason: "remote-delete-missing-baseline",
			firstSeenAt: 1000,
			lastSeenAt: 1000,
			episodeId: "ep-a",
		},
	];
	const entriesJsonBefore = JSON.stringify(entries);

	auditAttentionEntries({
		vault,
		preservedUnresolvedEntries: entries,
	});

	assert.equal(JSON.stringify(entries), entriesJsonBefore, "audit does not mutate input array or objects");
}

console.log("\n--- Retirement settlement proof: only settled divergences retire ---");
{
	const deterministicHash = async (content: string) => `hash:${content}`;
	const decide = (input: {
		crdtContent: string | null;
		baselineHash: string | null;
		diskContent: string | null;
	}) => classifyMarkdownRetirementSettlement({ ...input, hash: deterministicHash });

	assert.equal(
		(await decide({ crdtContent: null, baselineHash: "hash:base", diskContent: null })).proof,
		"crdt-untracked",
		"untracked CRDT retires: the engine holds no divergent content",
	);
	assert.equal(
		(await decide({ crdtContent: "base", baselineHash: null, diskContent: null })).ok,
		false,
		"missing baseline cannot prove settlement and keeps the fence",
	);
	assert.equal(
		(await decide({ crdtContent: "base", baselineHash: "hash:base", diskContent: "diverged" })).proof,
		"crdt-at-baseline",
		"CRDT still at the durable baseline retires losslessly",
	);
	assert.equal(
		(await decide({ crdtContent: "crdt", baselineHash: "hash:base", diskContent: "crdt" })).proof,
		"converged",
		"converged CRDT and disk retires losslessly",
	);
	assert.equal(
		(await decide({ crdtContent: "crdt", baselineHash: "hash:base", diskContent: "base" })).proof,
		"disk-at-baseline",
		"disk still at the durable baseline retires losslessly",
	);
	assert.equal(
		(await decide({ crdtContent: "crdt-moved", baselineHash: "hash:base", diskContent: "disk-moved" })).ok,
		false,
		"both sides moved past the baseline keeps the fence",
	);
	assert.equal(
		(await decide({ crdtContent: "crdt-moved", baselineHash: "hash:base", diskContent: null })).ok,
		false,
		"CRDT moved with the file missing keeps the fence",
	);
}

console.log("\nAll Attention Audit & Retirement tests passed successfully!\n");
