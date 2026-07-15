import * as Y from "yjs";
import type { TFile } from "obsidian";
import {
	captureBlobRestoreAuthority,
	captureMarkdownRestoreAuthority,
	restoreFromSnapshot,
} from "../src/sync/snapshotClient";
import {
	restoreRecoveryVersionToLiveDoc,
	sha256Hex,
} from "../src/sync/recoverySnapshotClient";
import {
	getBlobRefPriorHashes,
	type BlobRef,
} from "../src/types";
import {
	captureRestoreDiskRevision,
	commitWithCurrentRestoreDiskAuthority,
	type RestoreDiskPrecondition,
} from "../src/snapshots/restoreDiskSettlement";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
	} else {
		console.error(`  FAIL  ${message}`);
		failed++;
	}
}

function makeDiskFile(path: string, revision = 1): TFile {
	return {
		path,
		stat: { ctime: revision, mtime: revision, size: revision },
	} as TFile;
}

function presentDiskPrecondition(
	file: TFile,
	content: string,
): RestoreDiskPrecondition {
	return {
		kind: "present",
		content,
		fileIdentity: file,
		revision: captureRestoreDiskRevision(file),
	};
}

console.log("\n--- Test 8: awaited preparation cannot erase a newer attachment ref/tombstone ---");
{
	const path = "images/race.png";
	const snapshotDoc = new Y.Doc();
	snapshotDoc.getMap("pathToBlob").set(path, { hash: "a".repeat(64), size: 10 });
	const liveDoc = new Y.Doc();
	const liveRefs = liveDoc.getMap("pathToBlob");
	const liveTombstones = liveDoc.getMap("blobTombstones");
	liveRefs.set(path, { hash: "b".repeat(64), size: 20 });
	const authority = captureBlobRestoreAuthority(liveDoc, [path]);

	// Represents a remote attachment update landing while Markdown backups or
	// other restore preparation is awaited. Equal-value replacement is included
	// to prove that entry identity, not only hash/size, is fenced.
	await Promise.resolve();
	const newestRef = { hash: "b".repeat(64), size: 20 };
	liveDoc.transact(() => {
		liveRefs.set(path, newestRef);
	});

	const result = restoreFromSnapshot(snapshotDoc, liveDoc, {
		blobPaths: [path],
		expectedBlobAuthority: authority,
	});
	assert(result.blobsRestored === 0, "stale attachment restore applies no blob mutation");
	assert(
		result.blobRejected[0]?.reason === "live-blob-ref-changed",
		"final attachment authority check reports the newer blob ref",
	);
	assert(liveRefs.get(path) === newestRef, "newer attachment ref survives unchanged");

	const tombstoneAuthority = captureBlobRestoreAuthority(liveDoc, [path]);
	const newestTombstone = { deletedAt: 42, device: "remote" };
	liveTombstones.set(path, newestTombstone);
	const tombstoneResult = restoreFromSnapshot(snapshotDoc, liveDoc, {
		blobPaths: [path],
		expectedBlobAuthority: tombstoneAuthority,
	});
	assert(
		tombstoneResult.blobRejected[0]?.reason === "live-blob-tombstone-changed",
		"a newer attachment tombstone independently vetoes restore",
	);
	assert(liveTombstones.get(path) === newestTombstone, "newer attachment tombstone survives unchanged");

	const stableAuthority = captureBlobRestoreAuthority(liveDoc, [path]);
	const stableResult = restoreFromSnapshot(snapshotDoc, liveDoc, {
		blobPaths: [path],
		expectedBlobAuthority: stableAuthority,
	});
	assert(stableResult.blobRejected.length === 0, "stable attachment authority passes the fence");
	assert(stableResult.blobsRestored === 1, "stable attachment restore still succeeds");
	assert(
		(liveRefs.get(path) as { hash?: string } | undefined)?.hash === "a".repeat(64),
		"stable restore installs the selected snapshot ref",
	);
	assert(!liveTombstones.has(path), "stable restore clears the reviewed tombstone");

	snapshotDoc.destroy();
	liveDoc.destroy();
}

console.log("\n--- Test 8a: priorHashes-only in-place ABA invalidates attachment restore authority ---");
{
	const path = "images/prior-authority-aba.png";
	const targetHash = "1".repeat(64);
	const liveHash = "2".repeat(64);
	const reviewedPriorHash = "3".repeat(64);
	const replacementPriorHash = "4".repeat(64);
	const snapshotDoc = new Y.Doc();
	snapshotDoc.getMap<BlobRef>("pathToBlob").set(path, {
		hash: targetHash,
		size: 10,
	});
	const liveDoc = new Y.Doc();
	const liveRefs = liveDoc.getMap<BlobRef>("pathToBlob");
	liveRefs.set(path, {
		hash: liveHash,
		size: 20,
		priorHashes: [reviewedPriorHash],
	});
	const authority = captureBlobRestoreAuthority(liveDoc, [path]);
	const sameRef = liveRefs.get(path)!;

	// Plain objects stored in Y.Map can be mutated without replacing their object
	// identity. The captured value clone must still notice that only causal
	// overwrite authority changed while hash/size and ref identity stayed equal.
	sameRef.priorHashes![0] = replacementPriorHash;
	const result = restoreFromSnapshot(snapshotDoc, liveDoc, {
		blobPaths: [path],
		expectedBlobAuthority: authority,
	});

	assert(result.blobsRestored === 0, "priorHashes-only ABA applies no attachment restore");
	assert(
		result.blobRejected[0]?.reason === "live-blob-ref-changed",
		"cloned BlobRef authority detects an in-place priorHashes-only change",
	);
	assert(liveRefs.get(path) === sameRef, "the newer same-identity ref remains installed");
	assert(
		getBlobRefPriorHashes(liveRefs.get(path))[0] === replacementPriorHash,
		"the newer causal predecessor survives unchanged",
	);

	snapshotDoc.destroy();
	liveDoc.destroy();
}

console.log("\n--- Test 8b: attachment restore mints a transitive causal ref for provider peers ---");
{
	const path = "images/causal-restore.png";
	const snapshotHash = "5".repeat(64);
	const snapshotPriorHash = "6".repeat(64);
	const sharedPriorHash = "7".repeat(64);
	const liveHash = "8".repeat(64);
	const livePriorHash = "9".repeat(64);
	const snapshotDoc = new Y.Doc();
	snapshotDoc.getMap<BlobRef>("pathToBlob").set(path, {
		hash: snapshotHash,
		size: 30,
		priorHashes: [snapshotPriorHash, sharedPriorHash],
	});
	const liveDoc = new Y.Doc();
	const liveRefs = liveDoc.getMap<BlobRef>("pathToBlob");
	liveRefs.set(path, {
		hash: liveHash,
		size: 40,
		priorHashes: [livePriorHash, sharedPriorHash],
	});
	const result = restoreFromSnapshot(snapshotDoc, liveDoc, {
		blobPaths: [path],
		expectedBlobAuthority: captureBlobRestoreAuthority(liveDoc, [path]),
	});
	const restoredRef = liveRefs.get(path);

	assert(result.blobsRestored === 1, "stable attachment restore commits one causal ref");
	assert(restoredRef?.hash === snapshotHash, "restored ref points at the selected snapshot bytes");
	assert(
		JSON.stringify(getBlobRefPriorHashes(restoredRef)) === JSON.stringify([
			liveHash,
			livePriorHash,
			sharedPriorHash,
			snapshotPriorHash,
		]),
		"restore prepends live ref, then retains live and snapshot predecessor lineage",
	);

	// A different device receives this transaction with provider origin, so it
	// cannot rely on the restoring device's local oldValue. The minted ref itself
	// must carry the exact clean live-disk hash as its overwrite permit.
	const providerPeerDoc = new Y.Doc();
	Y.applyUpdate(providerPeerDoc, Y.encodeStateAsUpdate(liveDoc));
	const providerRef = providerPeerDoc
		.getMap<BlobRef>("pathToBlob")
		.get(path);
	assert(
		providerRef?.hash === snapshotHash
		&& getBlobRefPriorHashes(providerRef).includes(liveHash),
		"provider peer can authorize its clean live disk from the restored ref alone",
	);

	providerPeerDoc.destroy();
	snapshotDoc.destroy();
	liveDoc.destroy();
}

function seedActiveMarkdown(
	doc: Y.Doc,
	path: string,
	fileId: string,
	content: string,
): Y.Text {
	let text!: Y.Text;
	doc.transact(() => {
		doc.getMap("sys").set("schemaVersion", 2);
		text = new Y.Text();
		text.insert(0, content);
		doc.getMap<Y.Text>("idToText").set(fileId, text);
		doc.getMap("meta").set(fileId, { path, mtime: 1, device: "test" });
	});
	return text;
}

console.log("\n--- Test 1: awaited backup cannot erase a newer live CRDT/editor value ---");
{
	const snapshotDoc = new Y.Doc();
	seedActiveMarkdown(snapshotDoc, "notes/a.md", "file-a", "snapshot bytes");
	const liveDoc = new Y.Doc();
	const liveText = seedActiveMarkdown(liveDoc, "notes/a.md", "file-a", "reviewed bytes");
	const authority = captureMarkdownRestoreAuthority(liveDoc, ["notes/a.md"]);

	// Represents a user edit that lands while the service awaits disk read/
	// backup creation. The old implementation cleared this value afterwards.
	await Promise.resolve();
	liveDoc.transact(() => {
		liveText.delete(0, liveText.length);
		liveText.insert(0, "typed while backup awaited");
	});

	const result = restoreFromSnapshot(snapshotDoc, liveDoc, {
		markdownPaths: ["notes/a.md"],
		expectedMarkdownAuthority: authority,
	});
	assert(result.markdownRestored === 0, "stale restore applies no Markdown mutation");
	assert(
		result.markdownRejected[0]?.reason === "live-content-changed",
		"final authority check reports the newer CRDT content",
	);
	assert(
		liveText.toJSON() === "typed while backup awaited",
		"the newer live edit survives unchanged",
	);

	const editorRejected = restoreFromSnapshot(snapshotDoc, liveDoc, {
		markdownPaths: ["notes/a.md"],
		expectedMarkdownAuthority: captureMarkdownRestoreAuthority(liveDoc, ["notes/a.md"]),
		canCommitMarkdownRestore: () => false,
	});
	assert(
		editorRejected.markdownRejected[0]?.reason === "editor-authority-changed",
		"open-editor final fence can veto the restore",
	);
	assert(
		liveText.toJSON() === "typed while backup awaited",
		"editor veto leaves CRDT content untouched",
	);

	snapshotDoc.destroy();
	liveDoc.destroy();
}

console.log("\n--- Test 2: history hash await is fenced by exact Y.Text identity/content ---");
{
	const liveDoc = new Y.Doc();
	const liveText = seedActiveMarkdown(liveDoc, "notes/hash-race.md", "file-hash", "before");
	const expectedCurrentHash = await sha256Hex("before");
	const restorePromise = restoreRecoveryVersionToLiveDoc(liveDoc, {
		fileId: "file-hash",
		path: "notes/hash-race.md",
		content: "historical version",
		expectedCurrentHash,
	});

	// restoreRecoveryVersionToLiveDoc has captured the target and is awaiting
	// WebCrypto here. Mutate before its continuation resumes.
	liveDoc.transact(() => {
		liveText.delete(0, liveText.length);
		liveText.insert(0, "typed during hash");
	});
	const result = await restorePromise;
	assert(!result.restored, "history restore aborts after a concurrent edit");
	assert(
		result.reason === "live-authority-changed",
		"hash race is classified as stale live authority",
	);
	assert(liveText.toJSON() === "typed during hash", "hash-race edit is never cleared");
	liveDoc.destroy();
}

console.log("\n--- Test 3: historical A/F cannot hijack the live renamed B/F identity ---");
{
	const snapshotDoc = new Y.Doc();
	seedActiveMarkdown(snapshotDoc, "notes/A.md", "file-renamed", "old A version");
	const liveDoc = new Y.Doc();
	const liveText = seedActiveMarkdown(liveDoc, "notes/B.md", "file-renamed", "current B version");
	const liveMeta = liveDoc.getMap<{ path: string }>("meta");

	const snapshotResult = restoreFromSnapshot(snapshotDoc, liveDoc, {
		markdownPaths: ["notes/A.md"],
		expectedMarkdownAuthority: captureMarkdownRestoreAuthority(liveDoc, ["notes/A.md"]),
	});
	assert(
		snapshotResult.markdownRejected[0]?.reason === "snapshot-file-id-active-at-different-path",
		"vault snapshot rejects a file ID active at another path",
	);
	assert(liveMeta.get("file-renamed")?.path === "notes/B.md", "snapshot restore does not move B back to A");
	assert(liveText.toJSON() === "current B version", "snapshot restore does not clear B's text");

	const recoveryResult = await restoreRecoveryVersionToLiveDoc(liveDoc, {
		fileId: "file-renamed",
		path: "notes/A.md",
		content: "old A version",
		expectedCurrentHash: null,
	});
	assert(
		!recoveryResult.restored && recoveryResult.reason === "file-identity-moved",
		"file history rejects the same renamed-identity collision",
	);
	assert(liveMeta.get("file-renamed")?.path === "notes/B.md", "history restore preserves B metadata");
	assert(liveText.toJSON() === "current B version", "history restore preserves B content");

	snapshotDoc.destroy();
	liveDoc.destroy();
}

console.log("\n--- Test 4: same bytes in a replacement Y.Text are not mistaken for the reviewed target ---");
{
	const snapshotDoc = new Y.Doc();
	seedActiveMarkdown(snapshotDoc, "notes/identity.md", "file-identity", "snapshot bytes");
	const liveDoc = new Y.Doc();
	seedActiveMarkdown(liveDoc, "notes/identity.md", "file-identity", "same bytes");
	const authority = captureMarkdownRestoreAuthority(liveDoc, ["notes/identity.md"]);
	let replacement!: Y.Text;
	liveDoc.transact(() => {
		replacement = new Y.Text();
		replacement.insert(0, "same bytes");
		liveDoc.getMap<Y.Text>("idToText").set("file-identity", replacement);
	});

	const result = restoreFromSnapshot(snapshotDoc, liveDoc, {
		markdownPaths: ["notes/identity.md"],
		expectedMarkdownAuthority: authority,
	});
	assert(
		result.markdownRejected[0]?.reason === "live-text-identity-changed",
		"Y.Text identity replacement is detected even when bytes match",
	);
	assert(replacement.toJSON() === "same bytes", "replacement Y.Text is not overwritten");

	snapshotDoc.destroy();
	liveDoc.destroy();
}

console.log("\n--- Test 5: disk edit after backup prevents the CRDT restore from starting ---");
{
	const path = "notes/disk-race.md";
	const snapshotDoc = new Y.Doc();
	seedActiveMarkdown(snapshotDoc, path, "file-disk-race", "snapshot R");
	const liveDoc = new Y.Doc();
	const liveText = seedActiveMarkdown(liveDoc, path, "file-disk-race", "live C");
	const authority = captureMarkdownRestoreAuthority(liveDoc, [path]);
	const diskFile = makeDiskFile(path);
	let diskContent = "reviewed disk before backup";
	const diskVault = {
		getAbstractFileByPath: (candidate: string) => candidate === path ? diskFile : null,
		read: async (file: TFile) => {
			if (file !== diskFile) throw new Error("unexpected disk identity");
			return diskContent;
		},
	};
	const preconditions = new Map<string, RestoreDiskPrecondition>([[
		path,
		presentDiskPrecondition(diskFile, diskContent),
	]]);

	// The safety backup has completed, then an external writer changes the same
	// TFile in place. Identity-only fencing would miss this D value.
	diskContent = "external D after backup";
	let restoreCalls = 0;
	let liveTransactions = 0;
	liveDoc.on("afterTransaction", () => liveTransactions++);
	const attempt = await commitWithCurrentRestoreDiskAuthority(
		diskVault,
		preconditions,
		(isDiskIdentityCurrent) => {
			restoreCalls++;
			return restoreFromSnapshot(snapshotDoc, liveDoc, {
				markdownPaths: [path],
				expectedMarkdownAuthority: authority,
				canCommitMarkdownRestore: isDiskIdentityCurrent,
			});
		},
	);

	assert(attempt.kind === "stale", "changed disk bytes reject the all-path precondition");
	assert(restoreCalls === 0, "restoreFromSnapshot is not invoked for stale disk authority");
	assert(liveTransactions === 0, "no live Y.Doc transaction starts after the disk race");
	assert(liveText.toJSON() === "live C", "CRDT C survives instead of being replaced by snapshot R");
	assert(diskContent === "external D after backup", "external disk D is preserved unchanged");

	snapshotDoc.destroy();
	liveDoc.destroy();
}

console.log("\n--- Test 6: final disk identity replacement vetoes the Y.Doc transaction ---");
{
	const path = "notes/disk-identity-race.md";
	const snapshotDoc = new Y.Doc();
	seedActiveMarkdown(snapshotDoc, path, "file-disk-identity", "snapshot R");
	const liveDoc = new Y.Doc();
	const liveText = seedActiveMarkdown(liveDoc, path, "file-disk-identity", "live C");
	const authority = captureMarkdownRestoreAuthority(liveDoc, [path]);
	const reviewedFile = makeDiskFile(path);
	const replacementFile = makeDiskFile(path, 2);
	let currentFile: TFile | null = reviewedFile;
	const diskVault = {
		getAbstractFileByPath: (candidate: string) => candidate === path ? currentFile : null,
		read: async (file: TFile) => {
			if (file !== reviewedFile) throw new Error("unexpected disk identity");
			return "reviewed disk";
		},
	};
	const preconditions = new Map<string, RestoreDiskPrecondition>([[
		path,
		presentDiskPrecondition(reviewedFile, "reviewed disk"),
	]]);
	let liveTransactions = 0;
	liveDoc.on("afterTransaction", () => liveTransactions++);

	const attempt = await commitWithCurrentRestoreDiskAuthority(
		diskVault,
		preconditions,
		(isDiskIdentityCurrent) => {
			// Deterministic final-gap injection: byte validation passed, but the
			// exact path identity is replaced before restoreFromSnapshot commits.
			currentFile = replacementFile;
			return restoreFromSnapshot(snapshotDoc, liveDoc, {
				markdownPaths: [path],
				expectedMarkdownAuthority: authority,
				isMarkdownRestoreDiskAuthorityCurrent: isDiskIdentityCurrent,
			});
		},
	);

	assert(attempt.kind === "committed", "reviewed bytes allow entry into the synchronous restore fence");
	assert(
		attempt.kind === "committed"
		&& attempt.value.markdownRejected[0]?.reason === "disk-authority-changed",
		"the final exact TFile replacement is classified as stale disk authority",
	);
	assert(liveTransactions === 0, "identity replacement prevents the live Y.Doc transaction");
	assert(liveText.toJSON() === "live C", "identity-race CRDT content remains untouched");

	snapshotDoc.destroy();
	liveDoc.destroy();
}

console.log("\n--- Test 7: history restore rejects same-TFile bytes changed after backup ---");
{
	const path = "notes/history-disk-race.md";
	const liveDoc = new Y.Doc();
	const liveText = seedActiveMarkdown(liveDoc, path, "file-history-disk", "live C");
	const expectedCurrentContent = "live C";
	const expectedCurrentHash = await sha256Hex(expectedCurrentContent);
	const diskFile = makeDiskFile(path);
	let diskContent = "reviewed disk before backup";
	const diskVault = {
		getAbstractFileByPath: (candidate: string) => candidate === path ? diskFile : null,
		read: async (file: TFile) => {
			if (file !== diskFile) throw new Error("unexpected disk identity");
			return diskContent;
		},
	};
	const preconditions = new Map<string, RestoreDiskPrecondition>([[
		path,
		presentDiskPrecondition(diskFile, diskContent),
	]]);

	// Backup completed, then an external writer changed the bytes through the
	// same TFile object. The history restore must not reach its CRDT function.
	diskContent = "external D after backup";
	let restoreCalls = 0;
	let liveTransactions = 0;
	liveDoc.on("afterTransaction", () => liveTransactions++);
	const attempt = await commitWithCurrentRestoreDiskAuthority(
		diskVault,
		preconditions,
		(isDiskIdentityCurrent) => {
			restoreCalls++;
			return restoreRecoveryVersionToLiveDoc(liveDoc, {
				fileId: "file-history-disk",
				path,
				content: "historical version",
				expectedCurrentHash,
				expectedCurrentContent,
				isDiskRestoreAuthorityCurrent: isDiskIdentityCurrent,
			});
		},
	);

	assert(attempt.kind === "stale", "history restore rejects changed post-backup disk bytes");
	assert(restoreCalls === 0, "history CRDT restore function is never invoked for stale disk bytes");
	assert(liveTransactions === 0, "changed same-TFile bytes cause zero Y.Doc transactions");
	assert(liveText.toJSON() === "live C", "history disk race preserves the current CRDT bytes");
	assert(diskContent === "external D after backup", "history disk race preserves external disk bytes");

	liveDoc.destroy();
}

console.log("\n--- Test 8: history final fence rejects same-bytes TFile replacement ---");
{
	const path = "notes/history-identity-race.md";
	const liveDoc = new Y.Doc();
	const liveText = seedActiveMarkdown(liveDoc, path, "file-history-identity", "live C");
	const expectedCurrentContent = "live C";
	const expectedCurrentHash = await sha256Hex(expectedCurrentContent);
	const reviewedFile = makeDiskFile(path);
	const replacementFile = makeDiskFile(path, 2);
	let currentFile: TFile | null = reviewedFile;
	const diskVault = {
		getAbstractFileByPath: (candidate: string) => candidate === path ? currentFile : null,
		read: async (file: TFile) => {
			if (file !== reviewedFile) throw new Error("unexpected disk identity");
			return "same reviewed bytes";
		},
	};
	const preconditions = new Map<string, RestoreDiskPrecondition>([[
		path,
		presentDiskPrecondition(reviewedFile, "same reviewed bytes"),
	]]);
	let liveTransactions = 0;
	liveDoc.on("afterTransaction", () => liveTransactions++);

	const attempt = await commitWithCurrentRestoreDiskAuthority(
		diskVault,
		preconditions,
		(isDiskIdentityCurrent) => restoreRecoveryVersionToLiveDoc(liveDoc, {
			fileId: "file-history-identity",
			path,
			content: "historical version",
			expectedCurrentHash,
			expectedCurrentContent,
			// Deterministically replace the path identity after the helper's byte
			// read, but before the dedicated disk fence (which is evaluated last).
			canCommitRestore: () => {
				currentFile = replacementFile;
				return true;
			},
			isDiskRestoreAuthorityCurrent: isDiskIdentityCurrent,
		}),
	);
	const result = attempt.kind === "committed" ? await attempt.value : null;

	assert(attempt.kind === "committed", "same bytes enter the final synchronous history fence");
	assert(
		result?.restored === false && result.reason === "disk-authority-changed",
		"replacement TFile identity is rejected by the last pre-transaction fence",
	);
	assert(liveTransactions === 0, "same-bytes TFile replacement causes zero Y.Doc transactions");
	assert(liveText.toJSON() === "live C", "replacement race leaves current history target untouched");

	liveDoc.destroy();
}

console.log("\n--- Test 9: stable history authority commits synchronously and succeeds ---");
{
	const path = "notes/history-success.md";
	const liveDoc = new Y.Doc();
	const liveText = seedActiveMarkdown(liveDoc, path, "file-history-success", "live C");
	const expectedCurrentContent = "live C";
	const expectedCurrentHash = await sha256Hex(expectedCurrentContent);
	const diskFile = makeDiskFile(path);
	const diskVault = {
		getAbstractFileByPath: (candidate: string) => candidate === path ? diskFile : null,
		read: async (file: TFile) => {
			if (file !== diskFile) throw new Error("unexpected disk identity");
			return "reviewed disk";
		},
	};
	const preconditions = new Map<string, RestoreDiskPrecondition>([[
		path,
		presentDiskPrecondition(diskFile, "reviewed disk"),
	]]);
	let liveTransactions = 0;
	let transactionsBeforeRestoreReturned = -1;
	liveDoc.on("afterTransaction", () => liveTransactions++);

	const attempt = await commitWithCurrentRestoreDiskAuthority(
		diskVault,
		preconditions,
		(isDiskIdentityCurrent) => {
			const restore = restoreRecoveryVersionToLiveDoc(liveDoc, {
				fileId: "file-history-success",
				path,
				content: "historical version",
				expectedCurrentHash,
				expectedCurrentContent,
				isDiskRestoreAuthorityCurrent: isDiskIdentityCurrent,
			});
			transactionsBeforeRestoreReturned = liveTransactions;
			return restore;
		},
	);
	const result = attempt.kind === "committed" ? await attempt.value : null;

	assert(result?.restored === true, "stable disk and CRDT authority restore history successfully");
	assert(liveTransactions === 1, "successful history restore performs exactly one Y.Doc transaction");
	assert(
		transactionsBeforeRestoreReturned === 1,
		"captured-content fast path reaches the transaction without an internal await",
	);
	assert(liveText.toJSON() === "historical version", "successful history restore applies selected bytes");

	liveDoc.destroy();
}

console.log("\n--- Test 10: same-TFile microtask write after read cannot enter snapshot commit ---");
{
	const path = "notes/snapshot-stat-gap.md";
	const snapshotDoc = new Y.Doc();
	seedActiveMarkdown(snapshotDoc, path, "file-snapshot-stat-gap", "snapshot R");
	const liveDoc = new Y.Doc();
	const liveText = seedActiveMarkdown(liveDoc, path, "file-snapshot-stat-gap", "live C");
	const markdownAuthority = captureMarkdownRestoreAuthority(liveDoc, [path]);
	const diskFile = makeDiskFile(path);
	let diskContent = "reviewed disk C";
	let lookups = 0;
	const diskVault = {
		getAbstractFileByPath: (candidate: string) => {
			if (candidate !== path) return null;
			lookups++;
			if (lookups === 2) {
				// The post-read identity check still sees the original stat. Its
				// microtask runs before Promise.all resumes the outer commit path.
				queueMicrotask(() => {
					diskContent = "new same-TFile local D";
					diskFile.stat.mtime = 2;
					diskFile.stat.size = diskContent.length;
				});
			}
			return diskFile;
		},
		read: async (file: TFile) => {
			if (file !== diskFile) throw new Error("unexpected disk identity");
			return diskContent;
		},
	};
	const preconditions = new Map<string, RestoreDiskPrecondition>([ [
		path,
		presentDiskPrecondition(diskFile, diskContent),
	] ]);
	let restoreCalls = 0;
	let liveTransactions = 0;
	liveDoc.on("afterTransaction", () => liveTransactions++);

	const attempt = await commitWithCurrentRestoreDiskAuthority(
		diskVault,
		preconditions,
		(isDiskIdentityCurrent) => {
			restoreCalls++;
			return restoreFromSnapshot(snapshotDoc, liveDoc, {
				markdownPaths: [path],
				expectedMarkdownAuthority: markdownAuthority,
				isMarkdownRestoreDiskAuthorityCurrent: isDiskIdentityCurrent,
			});
		},
	);

	assert(attempt.kind === "stale", "post-read same-TFile stat advance invalidates snapshot authority");
	assert(restoreCalls === 0, "snapshot CRDT commit is never entered after the read/commit gap");
	assert(liveTransactions === 0, "snapshot stat race causes zero Y.Doc transactions");
	assert(liveText.toJSON() === "live C", "snapshot stat race preserves current CRDT C");
	assert(diskContent === "new same-TFile local D", "snapshot stat race preserves local disk D");

	snapshotDoc.destroy();
	liveDoc.destroy();
}

console.log("\n--- Test 11: same-TFile microtask write after read cannot enter history commit ---");
{
	const path = "notes/history-stat-gap.md";
	const liveDoc = new Y.Doc();
	const liveText = seedActiveMarkdown(liveDoc, path, "file-history-stat-gap", "live C");
	const expectedCurrentHash = await sha256Hex("live C");
	const diskFile = makeDiskFile(path);
	let diskContent = "reviewed history disk C";
	let lookups = 0;
	const diskVault = {
		getAbstractFileByPath: (candidate: string) => {
			if (candidate !== path) return null;
			lookups++;
			if (lookups === 2) {
				queueMicrotask(() => {
					diskContent = "new history local D";
					diskFile.stat.mtime = 2;
					diskFile.stat.size = diskContent.length;
				});
			}
			return diskFile;
		},
		read: async (file: TFile) => {
			if (file !== diskFile) throw new Error("unexpected disk identity");
			return diskContent;
		},
	};
	const preconditions = new Map<string, RestoreDiskPrecondition>([ [
		path,
		presentDiskPrecondition(diskFile, diskContent),
	] ]);
	let restoreCalls = 0;
	let liveTransactions = 0;
	liveDoc.on("afterTransaction", () => liveTransactions++);

	const attempt = await commitWithCurrentRestoreDiskAuthority(
		diskVault,
		preconditions,
		(isDiskIdentityCurrent) => {
			restoreCalls++;
			return restoreRecoveryVersionToLiveDoc(liveDoc, {
				fileId: "file-history-stat-gap",
				path,
				content: "historical R",
				expectedCurrentHash,
				expectedCurrentContent: "live C",
				isDiskRestoreAuthorityCurrent: isDiskIdentityCurrent,
			});
		},
	);

	assert(attempt.kind === "stale", "post-read same-TFile stat advance invalidates history authority");
	assert(restoreCalls === 0, "history CRDT commit is never entered after the read/commit gap");
	assert(liveTransactions === 0, "history stat race causes zero Y.Doc transactions");
	assert(liveText.toJSON() === "live C", "history stat race preserves current CRDT C");
	assert(diskContent === "new history local D", "history stat race preserves local disk D");

	liveDoc.destroy();
}

if (failed > 0) {
	console.error(`\n${failed} snapshot restore authority test(s) failed.`);
	process.exit(1);
}

console.log(`\nAll ${passed} snapshot restore authority tests passed.`);
