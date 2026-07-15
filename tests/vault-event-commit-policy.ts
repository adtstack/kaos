import { readFileSync } from "node:fs";
import * as Y from "yjs";
import {
	planBlobDeleteCommit,
	planMarkdownDeleteCommit,
	planRenameEventCommit,
} from "../src/sync/policy/vaultEventCommitPolicy";
import {
	BlobSyncManager,
	type BlobSettlementStage,
} from "../src/sync/blobSync";
import { VaultSync } from "../src/sync/vaultSync";
import type { PendingBlobMutationBase } from "../src/sync/pendingBlobIntentJournal";
import type { BlobRef, BlobTombstone } from "../src/types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${message}`);
	failed++;
}

function makeBlobRenameVaultSync(): VaultSync {
	const ydoc = new Y.Doc();
	const vaultSync = Object.create(VaultSync.prototype) as VaultSync & {
		_eventRing: Array<{ ts: string; msg: string }>;
	};
	vaultSync.ydoc = ydoc;
	vaultSync.pathToBlob = ydoc.getMap<BlobRef>("pathToBlob");
	vaultSync.blobMeta = ydoc.getMap("blobMeta");
	vaultSync.blobTombstones = ydoc.getMap<BlobTombstone>("blobTombstones");
	vaultSync._eventRing = [];
	return vaultSync;
}

function exactLiveBase(
	vaultSync: VaultSync,
	path: string,
	ref: BlobRef,
): PendingBlobMutationBase {
	const expectedSourceVersion = vaultSync.getBlobSourceVersion(path);
	if (!expectedSourceVersion) throw new Error(`Missing source version for ${path}`);
	return {
		known: true,
		ref,
		sourceVersionKnown: true,
		expectedSourceVersion,
	};
}

console.log("\n--- Blob delete commit fence: path occupancy decides the lane ---");
{
	assert(
		planBlobDeleteCommit("missing").kind === "commit-delete",
		"missing blob path may commit the delete event",
	);
	assert(
		planBlobDeleteCommit("file").kind === "admit-replacement",
		"same-path blob replacement is fresh admission, not a tombstone",
	);
	assert(
		planBlobDeleteCommit("non-file").kind === "quarantine-path-collision",
		"same-path non-file blob winner is quarantined",
	);
}

console.log("\n--- Blob delete: a live path suppression token cannot swallow user intent ---");
{
	const path = "assets/fresh-download.png";
	const settledRef: BlobRef = { hash: "e".repeat(64), size: 31 };
	const deleteCalls: Array<{
		path: string;
		base: PendingBlobMutationBase;
		device?: string;
	}> = [];
	const settledWrites: Array<{ path: string; ref: BlobRef | undefined }> = [];
	const manager = Object.assign(Object.create(BlobSyncManager.prototype), {
		attentionAcceptInFlight: new Set<string>(),
		fenceTransfersForPath: () => 1,
		uploadDebounce: new Map<string, ReturnType<typeof setTimeout>>(),
		uploadQueue: new Map<string, unknown>(),
		preservedUnresolved: { resolve: () => false },
		hashCache: {},
		settledSourceVersions: { [path]: "1:1" },
		getSettledRef: (candidatePath: string) => candidatePath === path ? settledRef : undefined,
		recordSettledRef: (candidatePath: string, ref: BlobRef | undefined) => {
			settledWrites.push({ path: candidatePath, ref });
		},
		// Simulates the still-live token left by a just-completed remote create.
		suppressedPaths: new Map([[path, Date.now() + 60_000]]),
		vaultSync: {
			getBlobRef: (candidatePath: string) => candidatePath === path ? settledRef : undefined,
			getBlobSourceVersion: (candidatePath: string) => candidatePath === path ? "1:1" : undefined,
			isBlobTombstoned: () => false,
			deleteBlobRefIfCurrent: (
				deletedPath: string,
				base: PendingBlobMutationBase,
				device?: string,
			) => {
				deleteCalls.push({ path: deletedPath, base, device });
				return { kind: "deleted" as const, ref: settledRef };
			},
		},
	}) as unknown as BlobSyncManager;

	const result = BlobSyncManager.prototype.handleFileDelete.call(
		manager,
		path,
		"device-local",
	);
	assert(result.kind === "deleted", "guarded manager delete commits the exact settled source");
	assert(deleteCalls.length === 1, "user delete publishes exactly one blob tombstone");
	assert(
		deleteCalls[0]?.path === path && deleteCalls[0]?.device === "device-local",
		"published tombstone preserves path and device",
	);
	assert(
		deleteCalls[0]?.base.known === true
			&& JSON.stringify(deleteCalls[0]?.base.ref) === JSON.stringify(settledRef)
			&& deleteCalls[0]?.base.sourceVersionKnown === true
			&& deleteCalls[0]?.base.expectedSourceVersion === "1:1",
		"handleFileDelete derives exact ref and CRDT episode CAS authority",
	);
	assert(
		settledWrites.length === 1
			&& settledWrites[0]?.path === path
			&& settledWrites[0]?.ref === undefined,
		"settled source authority is cleared only after guarded deletion succeeds",
	);
	assert(
		(manager as unknown as { suppressedPaths: Map<string, number> }).suppressedPaths.has(path),
		"delete publication does not consult or consume the unrelated path TTL token",
	);
}

console.log("\n--- Delete commit fence: same-path occupants ---");
{
	assert(
		planMarkdownDeleteCommit("missing").kind === "commit-delete",
		"path absence is the only state that authorizes a tombstone",
	);
	assert(
		planMarkdownDeleteCommit("file").kind === "admit-replacement",
		"same-path recreated TFile is admitted instead of tombstoned",
	);
	assert(
		planMarkdownDeleteCommit("non-file").kind === "quarantine-path-collision",
		"same-path folder/non-file occupant is quarantined",
	);
}

console.log("\n--- Rename commit fence: delayed namespace changes ---");
{
	assert(
		planRenameEventCommit({
			targetMatchesEventFile: true,
			oldPathIsMissing: true,
		}).kind === "commit-rename",
		"exact target identity plus absent old path authorizes rename handling",
	);
	const replacedTarget = planRenameEventCommit({
		targetMatchesEventFile: false,
		oldPathIsMissing: true,
	});
	assert(
		replacedTarget.kind === "quarantine-path-collision" &&
		replacedTarget.reason === "target-replaced",
		"delayed rename cannot claim a replacement target TFile",
	);
	const recreatedOldPath = planRenameEventCommit({
		targetMatchesEventFile: true,
		oldPathIsMissing: false,
	});
	assert(
		recreatedOldPath.kind === "quarantine-path-collision" &&
		recreatedOldPath.reason === "old-path-reoccupied",
		"delayed rename cannot erase a recreated old path",
	);
	assert(
		planRenameEventCommit({
			targetMatchesEventFile: false,
			oldPathIsMissing: false,
		}).kind === "quarantine-path-collision",
		"two-sided namespace replacement fails closed",
	);
}

console.log("\n--- Guarded blob delete: stale and unknown source authority fail closed ---");
{
	const vaultSync = makeBlobRenameVaultSync();
	const staleRef: BlobRef = { hash: "1".repeat(64), size: 11 };
	const currentRef: BlobRef = { hash: "2".repeat(64), size: 22 };
	const path = "assets/delete.png";
	vaultSync.pathToBlob.set(path, currentRef);

	const staleResult = vaultSync.deleteBlobRefIfCurrent(
		path,
		exactLiveBase(vaultSync, path, staleRef),
		"device-stale",
	);
	assert(staleResult.kind === "source-conflict", "stale settled delete base is rejected");
	assert(
		JSON.stringify(vaultSync.pathToBlob.get(path)) === JSON.stringify(currentRef),
		"source conflict preserves the concurrently advanced remote ref",
	);
	assert(
		vaultSync.getAuthoritativeBlobDeleteSnapshot(path) === null,
		"source conflict does not manufacture a tombstone for the newer ref",
	);

	const unknownResult = vaultSync.deleteBlobRefIfCurrent(
		path,
		{ known: false },
		"device-unknown",
	);
	assert(unknownResult.kind === "unknown-source", "unknown delete base fails closed");
	assert(
		JSON.stringify(vaultSync.pathToBlob.get(path)) === JSON.stringify(currentRef),
		"unknown source authority cannot erase a live remote ref",
	);

	const exactResult = vaultSync.deleteBlobRefIfCurrent(
		path,
		exactLiveBase(vaultSync, path, currentRef),
		"device-exact",
	);
	assert(exactResult.kind === "deleted", "exact current source ref authorizes guarded deletion");
	assert(!vaultSync.pathToBlob.has(path), "successful guarded deletion removes the live ref");
	assert(
		JSON.stringify(
			vaultSync.getAuthoritativeBlobDeleteSnapshot(path)?.deletedRef,
		) === JSON.stringify(currentRef),
		"successful guarded deletion records the exact deleted ref",
	);
	assert(
		vaultSync.deleteBlobRefIfCurrent(path, { known: false }).kind === "already-absent",
		"replaying a committed delete is idempotent once the source is absent",
	);
}

console.log("\n--- Guarded blob delete: same-H1 authority ABA is rejected ---");
{
	const vaultSync = makeBlobRenameVaultSync();
	const path = "assets/aba.png";
	const h1: BlobRef = { hash: "8".repeat(64), size: 38 };
	vaultSync.pathToBlob.set(path, h1);
	const staleEpisode = exactLiveBase(vaultSync, path, h1);
	const peer = makeBlobRenameVaultSync();
	Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(vaultSync.ydoc));
	assert(
		peer.getBlobSourceVersion(path) === staleEpisode.expectedSourceVersion,
		"the source episode identity survives Yjs replication/persistence encoding",
	);
	vaultSync.pathToBlob.delete(path);
	vaultSync.pathToBlob.set(path, h1);
	assert(
		vaultSync.getBlobSourceVersion(path) !== staleEpisode.expectedSourceVersion,
		"byte-identical H1 revival receives a distinct CRDT source episode",
	);
	const result = vaultSync.deleteBlobRefIfCurrent(path, staleEpisode, "device-aba");
	assert(
		result.kind === "source-conflict" && result.mutationApplied === false,
		"an old H1 episode cannot delete a revived H1 episode",
	);
	assert(vaultSync.pathToBlob.has(path), "the revived H1 remains live after stale CAS rejection");
}

console.log("\n--- Guarded blob delete: synchronous revival is a mutated conflict ---");
{
	const vaultSync = makeBlobRenameVaultSync();
	const path = "assets/reentrant-aba.png";
	const h1: BlobRef = { hash: "9".repeat(64), size: 39 };
	vaultSync.pathToBlob.set(path, h1);
	const originalEpisode = exactLiveBase(vaultSync, path, h1);
	const revive = () => {
		if (!vaultSync.pathToBlob.has(path)) vaultSync.pathToBlob.set(path, h1);
	};
	vaultSync.pathToBlob.observe(revive);
	const result = vaultSync.deleteBlobRefIfCurrent(path, originalEpisode, "device-reentrant");
	vaultSync.pathToBlob.unobserve(revive);
	assert(
		result.kind === "source-conflict" && result.mutationApplied === true,
		"delete followed by synchronous observer revival is not misclassified as no-mutation",
	);
	assert(vaultSync.pathToBlob.has(path), "the observer-revived H1 is visible after the transaction");
	const replay = vaultSync.deleteBlobRefIfCurrent(path, originalEpisode, "device-replay");
	assert(
		replay.kind === "source-conflict" && replay.mutationApplied === false,
		"the original episode cannot delete the re-entrant H1 a second time",
	);
}

console.log("\n--- Guarded blob upload: same-ref source-version ABA is rejected ---");
{
	const vaultSync = makeBlobRenameVaultSync();
	const path = "assets/upload-aba.png";
	const h1: BlobRef = { hash: "a".repeat(64), size: 41 };
	const h2: BlobRef = { hash: "b".repeat(64), size: 42 };
	vaultSync.pathToBlob.set(path, h1);
	const staleSourceVersion = vaultSync.getBlobSourceVersion(path);
	if (!staleSourceVersion) throw new Error("Missing initial upload source version");
	vaultSync.pathToBlob.delete(path);
	vaultSync.pathToBlob.set(path, h1);
	const revivedSourceVersion = vaultSync.getBlobSourceVersion(path);
	assert(
		revivedSourceVersion !== staleSourceVersion,
		"same-ref H1 revival changes the exact upload source episode",
	);
	const staleResult = vaultSync.setBlobRef(
		path,
		h2.hash,
		h2.size,
		"image/png",
		"device-stale",
		{
			expectedCurrentRef: h1,
			expectedCurrentSourceVersion: staleSourceVersion,
			causalBaseRef: h1,
		},
	);
	assert(staleResult === null, "stale same-ref upload source authority is rejected");
	assert(
		JSON.stringify(vaultSync.getBlobRef(path)) === JSON.stringify(h1)
			&& vaultSync.getBlobSourceVersion(path) === revivedSourceVersion,
		"stale upload rejection preserves the revived H1 episode",
	);
	const missingVersionResult = vaultSync.setBlobRef(
		path,
		h2.hash,
		h2.size,
		"image/png",
		"device-missing-version",
		{
			expectedCurrentRef: h1,
			causalBaseRef: h1,
		},
	);
	assert(
		missingVersionResult === null,
		"a live expected upload ref without an exact source version fails closed",
	);
}

console.log("\n--- Guarded blob upload: nested same-ref observer keeps the commit episode distinct ---");
{
	const vaultSync = makeBlobRenameVaultSync();
	const path = "assets/upload-reentrant-aba.png";
	const h1: BlobRef = { hash: "c".repeat(64), size: 51 };
	const h2: BlobRef = { hash: "d".repeat(64), size: 52 };
	vaultSync.pathToBlob.set(path, h1);
	const h1SourceVersion = vaultSync.getBlobSourceVersion(path);
	if (!h1SourceVersion) throw new Error("Missing guarded upload base source version");
	let observerRan = false;
	let sourceVersionBeforeNestedSet: string | undefined;
	let sourceVersionAfterNestedSet: string | undefined;
	const nestedSameRefSet = () => {
		if (observerRan) return;
		observerRan = true;
		sourceVersionBeforeNestedSet = vaultSync.getBlobSourceVersion(path);
		const current = vaultSync.getBlobRef(path);
		if (!current) throw new Error("Missing just-committed ref in observer");
		vaultSync.pathToBlob.set(path, {
			...current,
			...(current.priorHashes ? { priorHashes: [...current.priorHashes] } : {}),
		});
		sourceVersionAfterNestedSet = vaultSync.getBlobSourceVersion(path);
	};
	vaultSync.pathToBlob.observe(nestedSameRefSet);
	const result = vaultSync.setBlobRef(
		path,
		h2.hash,
		h2.size,
		"image/png",
		"device-reentrant",
		{
			expectedCurrentRef: h1,
			expectedCurrentSourceVersion: h1SourceVersion,
			causalBaseRef: h1,
		},
	);
	vaultSync.pathToBlob.unobserve(nestedSameRefSet);
	assert(result !== null, "the guarded ref commit itself succeeds before nested observer ABA");
	if (!result) throw new Error("Expected guarded upload commit result");
	assert(observerRan, "Yjs observer performs a nested same-ref set synchronously");
	assert(
		result.sourceVersion === sourceVersionBeforeNestedSet,
		"setBlobRef returns the exact episode created by its own commit",
	);
	assert(
		sourceVersionAfterNestedSet === vaultSync.getBlobSourceVersion(path)
			&& sourceVersionAfterNestedSet !== result.sourceVersion,
		"current source version reflects the nested same-ref episode, not the original commit",
	);
	assert(
		JSON.stringify(result.ref) === JSON.stringify(vaultSync.getBlobRef(path)),
		"same-ref ABA changes episode identity without changing the committed ref value",
	);

	const stage: BlobSettlementStage = {
		stageId: "upload-stage-reentrant",
		kind: "upload",
		ref: result.ref,
		sourceVersion: result.sourceVersion,
		stagedAt: Date.now(),
	};
	const settlementStages = { [path]: stage };
	let finalizeCalls = 0;
	let abortCalls = 0;
	const manager = Object.assign(Object.create(BlobSyncManager.prototype), {
		vaultSync,
		settlementStages,
		settlementPersistence: {
			stage: async () => undefined,
			finalize: async () => { finalizeCalls++; },
			retire: async () => undefined,
			abort: async () => { abortCalls++; },
		},
	}) as unknown as BlobSyncManager;
	const finalized = await (
		BlobSyncManager.prototype as unknown as {
			finalizeSettlementStage(
				candidatePath: string,
				candidateStage: BlobSettlementStage,
				ref: BlobRef,
				expectedSourceVersion?: string,
			): Promise<boolean>;
		}
	).finalizeSettlementStage.call(
		manager,
		path,
		stage,
		result.ref,
		result.sourceVersion,
	);
	assert(!finalized, "BlobSync refuses to finalize against the nested same-ref episode");
	assert(
		settlementStages[path] === stage && finalizeCalls === 0 && abortCalls === 0,
		"ambiguous upload keeps its durable stage and never converts failure into a safe abort",
	);
}

console.log("\n--- Causal blob rename: source tombstone is self-contained ---");
{
	const vaultSync = makeBlobRenameVaultSync();
	const sourceRef: BlobRef = {
		hash: "a".repeat(64),
		size: 17,
		priorHashes: ["b".repeat(64)],
	};
	vaultSync.pathToBlob.set("assets/old.png", sourceRef);

	const result = vaultSync.renameBlobRefWithTombstoneIfCurrent(
		"assets/old.png",
		"assets/new.png",
		exactLiveBase(vaultSync, "assets/old.png", sourceRef),
		"device-a",
	);
	const snapshot = vaultSync.getAuthoritativeBlobDeleteSnapshot("assets/old.png");
	assert(result.kind === "moved", "blob rename moves the source ref in one causal operation");
	assert(!vaultSync.pathToBlob.has("assets/old.png"), "old blob ref is removed");
	assert(
		JSON.stringify(vaultSync.pathToBlob.get("assets/new.png")) === JSON.stringify(sourceRef),
		"destination receives the exact source ref and lineage",
	);
	assert(
		JSON.stringify(snapshot?.deletedRef) === JSON.stringify(sourceRef),
		"old-path tombstone carries the exact deleted source ref",
	);
	assert(snapshot?.device === "device-a", "old-path tombstone records the deleting device");
}

console.log("\n--- Causal blob rename: destination authority is never overwritten ---");
{
	const vaultSync = makeBlobRenameVaultSync();
	const sourceRef: BlobRef = { hash: "c".repeat(64), size: 23 };
	const destinationRef: BlobRef = { hash: "d".repeat(64), size: 29 };
	vaultSync.pathToBlob.set("assets/old.png", sourceRef);
	vaultSync.pathToBlob.set("assets/new.png", destinationRef);

	const result = vaultSync.renameBlobRefWithTombstoneIfCurrent(
		"assets/old.png",
		"assets/new.png",
		exactLiveBase(vaultSync, "assets/old.png", sourceRef),
		"device-b",
	);
	assert(result.kind === "destination-conflict", "different destination ref is reported as a conflict");
	assert(
		JSON.stringify(vaultSync.pathToBlob.get("assets/new.png")) === JSON.stringify(destinationRef),
		"existing destination ref remains authoritative",
	);
	assert(
		JSON.stringify(
			vaultSync.getAuthoritativeBlobDeleteSnapshot("assets/old.png")?.deletedRef,
		) === JSON.stringify(sourceRef),
		"source is still retired by an exact-ref tombstone",
	);
}

console.log("\n--- Causal blob rename: stale source authority cannot move a newer ref ---");
{
	const vaultSync = makeBlobRenameVaultSync();
	const staleRef: BlobRef = { hash: "5".repeat(64), size: 35 };
	const currentRef: BlobRef = { hash: "6".repeat(64), size: 36 };
	const destinationRef: BlobRef = { hash: "7".repeat(64), size: 37 };
	vaultSync.pathToBlob.set("assets/old.png", currentRef);
	vaultSync.pathToBlob.set("assets/new.png", destinationRef);

	const staleResult = vaultSync.renameBlobRefWithTombstoneIfCurrent(
		"assets/old.png",
		"assets/new.png",
		exactLiveBase(vaultSync, "assets/old.png", staleRef),
		"device-stale",
	);
	assert(staleResult.kind === "source-conflict", "rename rejects a stale expected source ref");
	assert(
		JSON.stringify(vaultSync.pathToBlob.get("assets/old.png")) === JSON.stringify(currentRef),
		"source conflict preserves the newer remote source ref",
	);
	assert(
		JSON.stringify(vaultSync.pathToBlob.get("assets/new.png")) === JSON.stringify(destinationRef),
		"source conflict also leaves destination authority untouched",
	);
	assert(
		vaultSync.getAuthoritativeBlobDeleteSnapshot("assets/old.png") === null,
		"stale rename does not tombstone the newer source episode",
	);

	const unknownResult = vaultSync.renameBlobRefWithTombstoneIfCurrent(
		"assets/old.png",
		"assets/other.png",
		{ known: false },
		"device-unknown",
	);
	assert(unknownResult.kind === "unknown-source", "rename with unknown source authority fails closed");
	assert(
		JSON.stringify(vaultSync.pathToBlob.get("assets/old.png")) === JSON.stringify(currentRef)
			&& !vaultSync.pathToBlob.has("assets/other.png"),
		"unknown rename cannot retire or copy a live source ref",
	);
}

console.log("\n--- main.ts wiring order ---");
{
	const main = readFileSync("src/main.ts", "utf8");
	const blobDeleteHelperStart = main.indexOf("private commitLocalBlobDelete(");
	const blobRenameHelperStart = main.indexOf("private commitLocalBlobRename(");
	const blobBaseHelperStart = main.indexOf("private pendingBlobMutationBase(");
	const blobDeleteHelper = main.slice(blobDeleteHelperStart, blobRenameHelperStart);
	const blobRenameHelper = main.slice(blobRenameHelperStart, blobBaseHelperStart);
	assert(
		blobDeleteHelperStart >= 0
			&& blobRenameHelperStart > blobDeleteHelperStart
			&& blobBaseHelperStart > blobRenameHelperStart,
		"local blob commit helpers are located",
	);
	assert(
		blobDeleteHelper.includes("recordPendingBlobDelete(")
			&& !blobDeleteHelper.includes("handleFileDelete(")
			&& !blobDeleteHelper.includes("deleteBlobRef"),
		"local delete helper only journals first; synchronous vault dispatch never mutates CRDT authority",
	);
	assert(
		blobRenameHelper.includes("recordPendingBlobRename(")
			&& !blobRenameHelper.includes("handleFileRename(")
			&& !blobRenameHelper.includes("renameBlobRefWithTombstone"),
		"local rename helper only journals first; CRDT mutation waits for durable replay",
	);
	const applyDeleteStart = main.indexOf("private applyPendingBlobDelete(");
	const applyRenameStart = main.indexOf("private applyPendingBlobRename(", applyDeleteStart);
	const applyEnd = main.indexOf("private isPendingBlobMutationConflict(", applyRenameStart);
	const applyDelete = main.slice(applyDeleteStart, applyRenameStart);
	const applyRename = main.slice(applyRenameStart, applyEnd);
	assert(
		applyDeleteStart >= 0
			&& applyDelete.includes("blobSync.handleFileDelete(intent.path")
			&& applyDelete.includes("vaultSync.deleteBlobRefIfCurrent(intent.path, base")
			&& applyDelete.includes('result.kind === "source-conflict"'),
		"durable delete replay passes the captured base through guarded manager/null CAS lanes",
	);
	assert(
		applyRenameStart > applyDeleteStart
			&& applyRename.includes("blobSync.handleFileRename(")
			&& applyRename.includes("vaultSync.renameBlobRefWithTombstoneIfCurrent(")
			&& applyRename.includes('result.kind === "source-conflict"'),
		"durable rename replay passes the captured base through guarded manager/null CAS lanes",
	);
	const renameStart = main.indexOf('this.app.vault.on("rename"');
	const renameEnd = main.indexOf('this.app.vault.on("delete"', renameStart);
	const renameHandler = main.slice(renameStart, renameEnd);
	const renameTargetFence = renameHandler.indexOf("getAbstractFileByPath(file.path)");
	const renameOldFence = renameHandler.indexOf("getAbstractFileByPath(oldPath)");
	const renameQuarantine = renameHandler.indexOf(
		'renameCommit.kind === "quarantine-path-collision"',
	);
	const quarantineReturn = renameHandler.indexOf("return;", renameQuarantine);
	const immediateOwnershipRedirect = renameHandler.indexOf(
		"redirectPendingDirtyPath(oldPath, file.path)",
	);
	const attentionCollision = renameHandler.indexOf(
		'ownershipRedirect.kind === "collision"',
	);
	const attentionCollisionReturn = renameHandler.indexOf("return;", attentionCollision);
	const consumeRemoteRename = renameHandler.indexOf(
		"consumeRemoteRename(oldPath, file.path, file)",
	);
	const queueRename = renameHandler.indexOf("queueRename(action.oldPath, action.newPath)");
	assert(renameStart >= 0 && renameEnd > renameStart, "rename handler is located");
	assert(
		renameTargetFence >= 0 && renameTargetFence < consumeRemoteRename,
		"rename target identity fence precedes remote suppression-token consumption",
	);
	assert(
		renameOldFence >= 0 && renameOldFence < consumeRemoteRename,
		"rename old-path absence fence precedes remote suppression-token consumption",
	);
	assert(
		renameQuarantine >= 0 &&
		quarantineReturn > renameQuarantine &&
		quarantineReturn < consumeRemoteRename,
		"failed rename fence returns before any remote token or rename action",
	);
	assert(
		consumeRemoteRename >= 0 && consumeRemoteRename < queueRename,
		"valid remote suppression keeps its existing position before local queueRename",
	);
	assert(
		immediateOwnershipRedirect > quarantineReturn
			&& immediateOwnershipRedirect < consumeRemoteRename
			&& immediateOwnershipRedirect < queueRename,
		"valid rename moves dirty/Attention ownership before remote consumption or local admission",
	);
	assert(
		attentionCollision > immediateOwnershipRedirect
			&& attentionCollisionReturn > attentionCollision
			&& attentionCollisionReturn < consumeRemoteRename
			&& attentionCollisionReturn < queueRename,
		"unresolved-episode collision returns before any remote token or CRDT rename action",
	);
	assert(
		renameHandler.includes('recordPreservedUnresolved(oldPath, "path-collision")') &&
		renameHandler.includes('recordPreservedUnresolved(file.path, "path-collision")'),
		"failed rename fence quarantines both Markdown namespaces",
	);
	assert(
		renameHandler.includes(
			'this.getBlobSync()?.recordPreservedUnresolved(oldPath, "path-collision")',
		) &&
		renameHandler.includes(
			'this.getBlobSync()?.recordPreservedUnresolved(file.path, "path-collision")',
		),
		"failed rename fence quarantines blob namespaces through BlobSync",
	);

	const queueBlobStart = renameHandler.indexOf('case "queue-blob-rename"');
	const tombstoneMarkdownStart = renameHandler.indexOf('case "tombstone-markdown"');
	const admitMarkdownStart = renameHandler.indexOf('case "admit-markdown"');
	const admitBlobStart = renameHandler.indexOf('case "admit-blob-via-event"');
	const deferBlobStart = renameHandler.indexOf('case "defer-blob-to-events"');
	const sameIdentityStart = renameHandler.indexOf('case "same-identity"');
	const queueBlobBranch = renameHandler.slice(queueBlobStart, tombstoneMarkdownStart);
	const tombstoneMarkdownBranch = renameHandler.slice(tombstoneMarkdownStart, admitMarkdownStart);
	const admitMarkdownBranch = renameHandler.slice(admitMarkdownStart, admitBlobStart);
	const admitBlobBranch = renameHandler.slice(admitBlobStart, deferBlobStart);
	const deferBlobBranch = renameHandler.slice(deferBlobStart, sameIdentityStart);
	assert(
		queueBlobBranch.includes("commitLocalBlobRename(")
			&& !queueBlobBranch.includes("queueRename("),
		"blob-to-blob rename routes through the journaled causal commit helper",
	);
	assert(
		tombstoneMarkdownBranch.includes("handleDelete(action.oldPath")
			&& tombstoneMarkdownBranch.includes("handleFileChange(file)"),
		"markdown-to-blob explicitly tombstones markdown and admits the blob",
	);
	assert(
		admitMarkdownBranch.includes("commitLocalBlobDelete(oldPath")
			&& admitMarkdownBranch.includes("markMarkdownDirty(file"),
		"blob-to-markdown routes deletion through the journaled helper and admits markdown",
	);
	assert(
		admitBlobBranch.includes("handleFileChange(file)"),
		"excluded-to-blob explicitly admits the blob",
	);
	assert(
		deferBlobBranch.includes("commitLocalBlobDelete(action.oldPath"),
		"blob leaving scope is journaled and explicitly tombstoned without relying on a delete event",
	);

	const deleteStart = main.indexOf('this.app.vault.on("delete"');
	const deleteEnd = main.indexOf('this.app.vault.on("create"', deleteStart);
	const deleteHandler = main.slice(deleteStart, deleteEnd);
	const deleteFence = deleteHandler.indexOf("getAbstractFileByPath(file.path)");
	const clearMarker = deleteHandler.indexOf("clearPreservedUnresolved(file.path)");
	const handleDelete = deleteHandler.indexOf("handleDelete(");
	assert(deleteStart >= 0 && deleteEnd > deleteStart, "delete handler is located");
	assert(
		deleteFence >= 0 && deleteFence < clearMarker && deleteFence < handleDelete,
		"delete path-absence fence precedes marker clearing and CRDT tombstone",
	);
	assert(
		deleteHandler.includes('markMarkdownDirty(currentOccupant, "create", opId)'),
		"same-path replacement receives a fresh dirty admission",
	);
	assert(
		deleteHandler.includes('recordPreservedUnresolved(file.path, "path-collision")'),
		"non-file delete occupant is quarantined",
	);

	const blobBranch = deleteHandler.indexOf("const blobSync = this.getBlobSync()");
	const blobOccupantFence = deleteHandler.indexOf(
		"getAbstractFileByPath(file.path)",
		blobBranch,
	);
	const blobReplacementAdmission = deleteHandler.indexOf(
		"blobSync?.admitReplacementAfterStaleDelete(currentOccupant)",
		blobBranch,
	);
	const blobCollisionMarker = deleteHandler.indexOf(
		'blobSync.recordPreservedUnresolved(file.path, "path-collision")',
		blobBranch,
	);
	const blobDelete = deleteHandler.indexOf(
		'commitLocalBlobDelete(file.path, "vault-delete-event")',
		blobBranch,
	);
	assert(blobBranch >= 0, "blob delete handler branch is located");
	assert(
		blobOccupantFence > blobBranch && blobOccupantFence < blobReplacementAdmission,
		"blob live-path identity is classified before replacement admission",
	);
	assert(
		blobReplacementAdmission < blobDelete && blobCollisionMarker < blobDelete,
		"replacement/collision handling precedes ordinary missing-path deletion",
	);
	assert(
		blobDelete > blobBranch
			&& !deleteHandler.slice(blobBranch).includes("isSuppressed(file.path)"),
		"ordinary missing-path deletion always journals a tombstone without consulting TTL suppression",
	);
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
