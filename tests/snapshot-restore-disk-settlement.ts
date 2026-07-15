import { readFileSync } from "node:fs";
import type { TFile } from "obsidian";
import type { DiskWriteOptions, DiskWriteResult } from "../src/sync/diskMirror";
import {
	captureRestoreDiskRevision,
	findIncoherentMarkdownRestoreReviewPaths,
	RESTORE_DISK_SETTLEMENT_FAILURE_REASON,
	settleRestoredMarkdownPath,
	type RestoreDiskPrecondition,
	type RestoreDiskWriter,
} from "../src/snapshots/restoreDiskSettlement";

let passed = 0;
let failed = 0;
function makeDiskFile(path: string, revision = 1): TFile {
	return {
		path,
		stat: { ctime: revision, mtime: revision, size: revision },
	} as TFile;
}

function presentDiskPrecondition(
	file: TFile,
	content: string,
): Extract<RestoreDiskPrecondition, { kind: "present" }> {
	return {
		kind: "present",
		content,
		fileIdentity: file,
		revision: captureRestoreDiskRevision(file),
	};
}

const REVIEWED_FILE_IDENTITY = makeDiskFile("notes/a.md");

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
	} else {
		console.error(`  FAIL  ${message}`);
		failed++;
	}
}

function makeWriter(
	result: DiskWriteResult | Error,
	onCall?: (path: string, force: boolean | undefined, options: DiskWriteOptions) => void,
): RestoreDiskWriter {
	return {
		async flushWrite(path, force, options = {}) {
			onCall?.(path, force, options);
			if (result instanceof Error) throw result;
			return result;
		},
	};
}

console.log("\n--- Test 1: existing-file restore carries the reviewed disk snapshot into CAS ---");
{
	let observed: {
		path: string;
		force: boolean | undefined;
		options: DiskWriteOptions;
	} | null = null;
	const settlement = await settleRestoredMarkdownPath(
		makeWriter(
			{
				kind: "written",
				path: "notes/a.md",
				isCreate: false,
				content: "snapshot version",
				contentHash: "hash-restored",
				baselineRecorded: true,
			},
			(path, force, options) => {
				observed = { path, force, options };
			},
		),
		"notes/a.md",
		presentDiskPrecondition(REVIEWED_FILE_IDENTITY, "reviewed local version"),
		"snapshot version",
	);

	assert(settlement.kind === "settled", "verified write is reported as settled");
	assert(observed?.path === "notes/a.md", "restore flushes the selected path");
	assert(observed?.force === true, "explicit restore requests an immediate forced flush");
	assert(
		observed?.options.expectedDiskContent === "reviewed local version",
		"pre-restore disk bytes are the write compare-and-swap precondition",
	);
	assert(
		observed?.options.expectedDiskFile === REVIEWED_FILE_IDENTITY,
		"pre-restore TFile identity is carried alongside the byte precondition",
	);
	assert(
		observed?.options.expectedDiskRevision?.mtime
			=== REVIEWED_FILE_IDENTITY.stat.mtime,
		"pre-restore immutable stat revision is carried into DiskMirror CAS",
	);
	assert(observed?.options.recordBaseline === true, "settled restore records a durable baseline");
	assert(
		observed?.options.allowCreateIfMissing !== true,
		"existing-file restore never gains missing-file create authority",
	);
}

console.log("\n--- Test 2: durable-baseline/CAS deferral is never reported as restore success ---");
{
	const settlement = await settleRestoredMarkdownPath(
		makeWriter({
			kind: "deferred",
			path: "notes/a.md",
			reason: "disk-changed-during-write",
		}),
		"notes/a.md",
		presentDiskPrecondition(REVIEWED_FILE_IDENTITY, "reviewed local version"),
		"snapshot version",
	);

	assert(settlement.kind === "not-settled", "deferred disk write fails restore settlement");
	assert(
		settlement.kind === "not-settled" && settlement.reason === "flush-not-settled",
		"failure preserves the DiskWriteResult instead of collapsing it into success",
	);
}

console.log("\n--- Test 3: undelete gets create authority only when disk was reviewed as missing ---");
{
	let observedOptions: DiskWriteOptions | null = null;
	const settlement = await settleRestoredMarkdownPath(
		makeWriter(
			{
				kind: "written",
				path: "notes/revived.md",
				isCreate: true,
				content: "revived",
				contentHash: "hash-revived",
				baselineRecorded: true,
			},
			(_path, _force, options) => {
				observedOptions = options;
			},
		),
		"notes/revived.md",
		{ kind: "missing" },
		"revived",
	);

	assert(settlement.kind === "settled", "verified undelete create is settled");
	assert(
		observedOptions?.allowCreateIfMissing === true,
		"reviewed missing path carries the expected-missing create contract",
	);
	assert(
		!("expectedDiskContent" in (observedOptions ?? {})),
		"missing-path precondition is not confused with an existing empty file",
	);
	assert(
		!("expectedDiskFile" in (observedOptions ?? {})),
		"missing-path restore does not invent an existing-file identity token",
	);
}

console.log("\n--- Test 4: a newer CRDT value cannot masquerade as the selected restore version ---");
{
	const settlement = await settleRestoredMarkdownPath(
		makeWriter({
			kind: "unchanged",
			path: "notes/a.md",
			content: "new concurrent edit",
			contentHash: "hash-new",
		}),
		"notes/a.md",
		presentDiskPrecondition(REVIEWED_FILE_IDENTITY, "reviewed local version"),
		"snapshot version",
	);

	assert(settlement.kind === "not-settled", "different settled content is not restore success");
	assert(
		settlement.kind === "not-settled" && settlement.reason === "settled-content-mismatch",
		"selected snapshot bytes remain part of the success condition",
	);
}

console.log("\n--- Test 5: unrecorded writes and unavailable writers remain incomplete ---");
{
	const noBaseline = await settleRestoredMarkdownPath(
		makeWriter({
			kind: "written",
			path: "notes/a.md",
			isCreate: false,
			content: "snapshot version",
			contentHash: "hash-restored",
			baselineRecorded: false,
		}),
		"notes/a.md",
		presentDiskPrecondition(REVIEWED_FILE_IDENTITY, "reviewed local version"),
		"snapshot version",
	);
	const unavailable = await settleRestoredMarkdownPath(
		null,
		"notes/a.md",
		presentDiskPrecondition(REVIEWED_FILE_IDENTITY, "reviewed local version"),
		"snapshot version",
	);
	const threw = await settleRestoredMarkdownPath(
		makeWriter(new Error("vault unavailable")),
		"notes/a.md",
		presentDiskPrecondition(REVIEWED_FILE_IDENTITY, "reviewed local version"),
		"snapshot version",
	);

	assert(
		noBaseline.kind === "not-settled" && noBaseline.reason === "baseline-not-recorded",
		"written result must include durable baseline settlement",
	);
	assert(
		unavailable.kind === "not-settled" && unavailable.reason === "disk-mirror-unavailable",
		"missing DiskMirror is explicit incomplete state",
	);
	assert(
		threw.kind === "not-settled" && threw.reason === "flush-threw",
		"unexpected flush exception is converted into explicit incomplete state",
	);
}

console.log("\n--- Test 5b: incomplete restore becomes durable Attention before returning ---");
{
	const path = "notes/quarantined-restore.md";
	let quarantined = false;
	let recordedReason: string | null = null;
	const writer: RestoreDiskWriter = {
		async flushWrite() {
			return quarantined
				? { kind: "blocked", path, reason: "preserved-unresolved" }
				: { kind: "deferred", path, reason: "disk-changed-during-write" };
		},
		isPreservedUnresolved: () => quarantined,
		recordPreservedUnresolved: (_path, reason) => {
			recordedReason = reason;
			quarantined = true;
		},
	};

	const settlement = await settleRestoredMarkdownPath(
		writer,
		path,
		presentDiskPrecondition(makeDiskFile(path), "reviewed local version"),
		"snapshot version",
	);
	const laterWrite = await writer.flushWrite(path, true);

	assert(settlement.kind === "not-settled", "failed explicit settlement remains incomplete");
	assert(
		recordedReason === RESTORE_DISK_SETTLEMENT_FAILURE_REASON,
		"the failure records the dedicated durable Attention reason before returning",
	);
	assert(
		laterWrite.kind === "blocked" && laterWrite.reason === "preserved-unresolved",
		"a later CRDT flush cannot overwrite the preserved disk file",
	);
}

console.log("\n--- Test 6: SnapshotService gates both restore flows on disk settlement ---");
{
	const source = readFileSync("src/snapshots/snapshotService.ts", "utf8");
	assert(
		source.includes("const diskFailures = await this.settleMarkdownRestores("),
		"vault snapshot and history restore paths await the settlement helper",
	);
	assert(
		source.split("const diskFailures = await this.settleMarkdownRestores(").length - 1 === 2,
		"both explicit markdown restore entry points verify disk settlement",
	);
	assert(
		!source.includes("getDiskMirror()?.flushWrite(path, true)"),
		"legacy fire-and-forget success path is removed",
	);
	assert(
		source.includes("Restore changed the synced state, but disk settlement was not verified"),
		"vault restore reports partial state instead of Restore complete",
	);
	assert(
		source.includes("throw new Error(message)"),
		"history restore rejects when disk settlement is not verified",
	);
	assert(
		source.split("const revision = captureRestoreDiskRevision(file);").length - 1 === 2
			&& source.includes("revision,"),
		"snapshot and history preparation retain an immutable disk stat revision",
	);
	assert(
		source.includes("Restore not started: the disk writer is unavailable")
			&& source.includes("History restore not started: the disk writer is unavailable"),
		"snapshot and history both fail closed before CRDT restore when no writer exists",
	);
	assert(
		source.split("this.deps.getDiskMirror() === restoreDiskMirror").length - 1 === 2,
		"both final CRDT fences retain the exact disk-writer runtime episode",
	);
	assert(
		source.includes('fileIdentity: file'),
		"restore preparation captures the exact TFile object used for its safety backup",
	);
	assert(
		source.includes("await commitWithCurrentRestoreDiskAuthority("),
		"snapshot restore validates all reviewed disk bytes before invoking the CRDT restore",
	);
	assert(
		source.split("await commitWithCurrentRestoreDiskAuthority(").length - 1 >= 4,
		"diff capture, pre-backup review, vault restore, and history restore all gate on reviewed disk bytes",
	);
	assert(
		source.includes("isMarkdownRestoreDiskAuthorityCurrent: isDiskIdentityCurrent"),
		"the exact disk identity fence is rechecked in the final pre-transaction callback",
	);
	assert(
		source.includes("expectedCurrentContent,")
			&& source.includes("isDiskRestoreAuthorityCurrent: isDiskIdentityCurrent"),
		"history restore uses the captured-content fast path and a final exact disk identity fence",
	);
	const diffReviewCapture = source.indexOf("const reviewedMarkdownPaths = [");
	const modalOpen = source.indexOf("new SnapshotDiffModal(");
	const restoreCallback = source.indexOf("async (markdownPaths, blobPaths) => {");
	const backupMutation = source.indexOf("const preparation = await this.prepareMarkdownRestore(", restoreCallback);
	const preBackupDiskCheck = source.indexOf("const diskReviewCheck = await commitWithCurrentRestoreDiskAuthority(", restoreCallback);
	assert(
		diffReviewCapture >= 0 && diffReviewCapture < modalOpen,
		"snapshot authority is captured when the displayed diff is built, before the modal opens",
	);
	const finalDiffRecompute = source.indexOf(
		"const diff = diffSnapshot(snapshotDoc, vaultSync.ydoc);",
		diffReviewCapture,
	);
	const finalAuthorityCheck = source.indexOf(
		"!this.isOpenEditorRestoreAuthorityCurrent(reviewedOpenEditorAuthority)",
		diffReviewCapture,
	);
	assert(
		finalAuthorityCheck >= 0
			&& finalDiffRecompute > finalAuthorityCheck
			&& finalDiffRecompute < modalOpen,
		"the rendered diff is recomputed after awaited capture and final authority validation",
	);
	assert(
		source.indexOf("finalSelectableMarkdownPaths.some", finalDiffRecompute) < modalOpen
			&& source.indexOf("finalSelectableBlobPaths.some", finalDiffRecompute) < modalOpen,
		"a newly selectable path cannot enter the modal without captured authority",
	);
	assert(
		source.indexOf("reviewedBlobAuthority = captureBlobRestoreAuthority(", diffReviewCapture) < modalOpen
			&& source.indexOf("reviewedMarkdownAuthority = captureMarkdownRestoreAuthority(", diffReviewCapture) < modalOpen
			&& source.indexOf("reviewedOpenEditorAuthority = this.captureOpenEditorRestoreAuthority(", diffReviewCapture) < modalOpen
			&& source.indexOf("reviewedDiskAuthority = await this.captureMarkdownRestoreDiskAuthority(", diffReviewCapture) < modalOpen,
		"diff-time authority covers attachment, Markdown CRDT, open editor, and exact disk state",
	);
	assert(
		restoreCallback >= 0
			&& source.indexOf("this.selectRestoreAuthority(", restoreCallback) < backupMutation,
		"restore validates only the selected subset of the authority shown in the diff",
	);
	assert(
		preBackupDiskCheck >= 0 && preBackupDiskCheck < backupMutation,
		"changed reviewed disk authority aborts before any safety-backup mutation",
	);
	assert(
		source.includes("reviewedPreconditions?: ReadonlyMap<string, RestoreDiskPrecondition>")
			&& source.includes("await this.writeMarkdownRestoreBackup(path, reviewed.content, backupDir)"),
		"backup and final settlement retain the diff-time disk bytes instead of recapturing click-time state",
	);
	assert(
		source.indexOf("findIncoherentMarkdownRestoreReviewPaths(", finalDiffRecompute) < modalOpen,
		"the modal opens only after CRDT, disk, and open-editor review authority is coherent",
	);
}

console.log("\n--- Test 7: modal review rejects hidden disk/editor authority ---");
{
	const path = "notes/coherent.md";
	const file = makeDiskFile(path);
	const markdown = new Map([[path, { fileId: "file-coherent", content: "visible C" }]]);
	const stableDisk = new Map<string, RestoreDiskPrecondition>([ [
		path,
		presentDiskPrecondition(file, "visible C"),
	] ]);
	const stableEditors = new Map([[path, [
		{ file, content: "visible C" },
		{ file, content: "visible C" },
	]]]);

	assert(
		findIncoherentMarkdownRestoreReviewPaths(
			[path],
			markdown,
			stableDisk,
			stableEditors,
		).length === 0,
		"stable C=D=all editor panes is safe to render and restore",
	);

	const editorDiverged = new Map([[path, [
		{ file, content: "new unsynced editor E" },
	]]]);
	assert(
		findIncoherentMarkdownRestoreReviewPaths(
			[path],
			markdown,
			stableDisk,
			editorDiverged,
		)[0] === path,
		"an editor-only E value that is absent from the CRDT diff blocks the modal",
	);

	const diskDiverged = new Map<string, RestoreDiskPrecondition>([ [
		path,
		presentDiskPrecondition(file, "new unsynced disk D"),
	] ]);
	assert(
		findIncoherentMarkdownRestoreReviewPaths(
			[path],
			markdown,
			diskDiverged,
			stableEditors,
		)[0] === path,
		"a disk-only D value that is absent from the CRDT diff blocks the modal",
	);
}

console.log("\n--- Test 8: deleted CRDT review requires an absent disk and no open pane ---");
{
	const path = "notes/deleted.md";
	const deletedMarkdown = new Map([[path, { fileId: null, content: null }]]);
	const missingDisk = new Map<string, RestoreDiskPrecondition>([[path, { kind: "missing" }]]);
	const noEditors = new Map<string, Array<{ file: TFile; content: string }>>([[path, []]]);
	assert(
		findIncoherentMarkdownRestoreReviewPaths(
			[path],
			deletedMarkdown,
			missingDisk,
			noEditors,
		).length === 0,
		"a genuinely absent live path is coherent with the deleted CRDT diff",
	);

	const hiddenFile = makeDiskFile(path);
	const preservedDisk = new Map<string, RestoreDiskPrecondition>([ [
		path,
		presentDiskPrecondition(hiddenFile, "preserved local work"),
	] ]);
	assert(
		findIncoherentMarkdownRestoreReviewPaths(
			[path],
			deletedMarkdown,
			preservedDisk,
			noEditors,
		)[0] === path,
		"a locally preserved file prevents an unseen undelete/restore overwrite",
	);
	assert(
		findIncoherentMarkdownRestoreReviewPaths(
			[path],
			deletedMarkdown,
			missingDisk,
			new Map([[path, [{ file: hiddenFile, content: "open unsaved work" }]]]),
		)[0] === path,
		"an open pane prevents an absent-CRDT restore from hiding unsaved work",
	);
}

if (failed > 0) {
	console.error(`\n${failed} snapshot restore disk settlement test(s) failed.`);
	process.exit(1);
}

console.log(`\nAll ${passed} snapshot restore disk settlement tests passed.`);
