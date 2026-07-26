import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import {
	ReconciliationController,
	type StableMarkdownReadResult,
} from "../src/runtime/reconciliationController";
import type { DiskIngestPort } from "../src/runtime/engineControlPort";

Object.defineProperty(globalThis, "__KAOS_QA_HARNESS_ENABLED__", {
	configurable: true,
	value: false,
});

class FakeTFile extends TFile {
	constructor(
		readonly path: string,
		readonly stat: { mtime: number; size: number },
	) {
		super();
	}
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

interface FixtureOptions {
	path?: string;
	opaqueOpenFileView?: boolean;
	readStable?: (
		path: string,
		reason: "create" | "modify",
		ready: StableMarkdownReadResult,
	) => Promise<StableMarkdownReadResult>;
	editorContent?: string;
	onBaselineDiskRead?: () => void;
	failBaselineDiskRead?: boolean;
	saveDiskIndex?: () => Promise<void>;
}

function makeFixture(options: FixtureOptions = {}) {
	const path = options.path ?? "notes/attention-fence.md";
	const content = "local preserved content\n";
	const file = new FakeTFile(path, { mtime: 41, size: content.length });
	let activeFile: TFile = file;
	const doc = new Y.Doc();
	const ytext = doc.getText("attention");
	let deletedPath = true;
	let deleteFingerprint = "markdown-delete-1";
	let activeFileIds: string[] = [];
	let entry = {
		path,
		kind: "markdown" as const,
		reason: "remote-delete-missing-baseline" as const,
		episodeId: "episode-1",
		firstSeenAt: 10,
		lastSeenAt: 20,
		localHash: "local-hash",
		knownRemoteHash: null,
	};
	let ensureCalls = 0;
	let clearCalls = 0;
	let baselineRecordCalls = 0;
	let diskPort: DiskIngestPort | null = null;
	let diskIndex = {};
	let opaqueOpenFileView = options.opaqueOpenFileView === true;
	const openView = options.editorContent === undefined
		? null
		: Object.assign(new MarkdownView(), {
			file,
			editor: { getValue: () => options.editorContent! },
		});
	const opaqueView = { file };

	const vaultSync = {
		isPathTombstoned: (candidate: string) => candidate === path && deletedPath,
		isMarkdownTombstoned: (candidate: string) => candidate === path && deletedPath,
		getAuthoritativeMarkdownDeleteSnapshot: (candidate: string) =>
			candidate === path && deletedPath && activeFileIds.length === 0
				? { fingerprint: deleteFingerprint }
				: null,
		getActiveFileIdsForPath: (candidate: string) => candidate === path ? [...activeFileIds] : [],
		getTextForPath: (candidate: string) => candidate === path && !deletedPath ? ytext : null,
		getFileIdForText: () => undefined,
		isPendingRenameTarget: () => false,
		serverAckTracker: {
			withActiveOpId: (_opId: string | undefined, work: () => unknown) => work(),
		},
		ensureFile: () => {
			ensureCalls++;
			deletedPath = false;
			activeFileIds = ["local-revive"];
			return ytext;
		},
	};
	const diskMirror = {
		getPreservedUnresolvedEntries: () => entry ? [entry] : [],
		isPreservedUnresolved: () => entry !== null,
		clearPreservedUnresolved: () => {
			clearCalls++;
			entry = null as never;
		},
		shouldSuppressCreate: async () => false,
		shouldSuppressModify: async () => false,
	};
	const ready: StableMarkdownReadResult = {
		kind: "ready",
		file,
		content,
		stat: file.stat,
	};
	const controller = new ReconciliationController({
		app: {
			vault: {
				getAbstractFileByPath: (candidate: string) => candidate === path ? activeFile : null,
				read: async () => {
					options.onBaselineDiskRead?.();
					if (options.failBaselineDiskRead) throw new Error("baseline disk read failed");
					return content;
				},
				adapter: { stat: async () => file.stat },
			},
			workspace: {
				getActiveViewOfType: () => openView,
				iterateAllLeaves: (callback: (leaf: { view: unknown }) => void) => {
					if (openView) callback({ view: openView });
					if (opaqueOpenFileView) callback({ view: opaqueView });
				},
			},
		} as any,
		getSettings: () => ({ deviceName: "attention-test" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => diskMirror as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
		recordBaselineText: () => {
			baselineRecordCalls++;
		},
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		readStableMarkdownFile: (candidate, reason) => options.readStable
			? options.readStable(candidate, reason, ready)
			: Promise.resolve(ready),
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: options.saveDiskIndex ?? (async () => {}),
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		registerDiskIngestPort: (port) => { diskPort = port; },
	});

	return {
		controller,
		doc,
		file,
		path,
		content,
		get diskPort() { return diskPort; },
		get ensureCalls() { return ensureCalls; },
		get clearCalls() { return clearCalls; },
		get baselineRecordCalls() { return baselineRecordCalls; },
		get diskIndex() { return diskIndex; },
		get ytext() { return ytext; },
		replaceActiveFileSameBytes() {
			activeFile = new FakeTFile(path, { mtime: 41, size: content.length });
		},
		replaceCrdtContent(next: string) {
			ytext.delete(0, ytext.length);
			ytext.insert(0, next);
		},
		setDeletedPath(value: boolean) { deletedPath = value; },
		setDeleteFingerprint(value: string) { deleteFingerprint = value; },
		setActiveFileIds(value: string[]) { activeFileIds = [...value]; },
		setOpaqueOpenFileView(value: boolean) { opaqueOpenFileView = value; },
		replaceAttentionEpisode(episodeId: string) {
			if (entry) entry = { ...entry, episodeId, lastSeenAt: entry.lastSeenAt + 1 };
		},
		get attentionEpisodeId() { return entry?.episodeId ?? null; },
	};
}

async function ignoreResolutionFailure(work: Promise<void>): Promise<void> {
	try {
		await work;
	} catch {
		// Failing closed is an acceptable public outcome for a stale settlement.
	}
}

const expectedEpisode = {
	reason: "remote-delete-missing-baseline" as const,
	episodeId: "episode-1",
	remoteDeleteFingerprint: "markdown-delete-1",
};

console.log("\n--- Markdown Attention resolution fencing ---");

// An action opened for a previous occurrence must not touch a replacement
// occurrence with the same path and reason.
{
	const fixture = makeFixture();
	await assert.rejects(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
			{ ...expectedEpisode, episodeId: "older-episode" },
		),
		/Attention state changed/,
	);
	assert.equal(fixture.ensureCalls, 0, "stale episode never reaches ensureFile");
	fixture.doc.destroy();
}

// Destructive or publishing actions are also bound to the local file version
// that was visible when the confirmation dialog opened.
{
	const fixture = makeFixture();
	await assert.rejects(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
			{
				...expectedEpisode,
				localFile: { kind: "file", mtime: 40, size: fixture.content.length },
			},
		),
		/Local file changed since the dashboard was opened/,
	);
	assert.equal(fixture.ensureCalls, 0, "changed local identity never reaches ensureFile");
	fixture.doc.destroy();
}

// A stale tombstone does not make the path authoritatively deleted when a
// live entry (including a collision) exists for the same path.
{
	const fixture = makeFixture();
	fixture.setActiveFileIds(["live-a", "live-b"]);
	await assert.rejects(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
		),
		/Remote deletion is no longer active/,
	);
	assert.equal(fixture.ensureCalls, 0, "stale tombstone plus active entries never revives");
	fixture.doc.destroy();
}

// A delete can be replaced by another delete while the path remains
// tombstoned. The tombstone fingerprint catches that otherwise-invisible race.
{
	let fixture!: ReturnType<typeof makeFixture>;
	fixture = makeFixture({
		readStable: async (_path, _reason, ready) => {
			fixture.setDeleteFingerprint("markdown-delete-2");
			return ready;
		},
	});
	await assert.rejects(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
			expectedEpisode,
		),
		/Remote deletion changed/,
	);
	assert.equal(fixture.ensureCalls, 0, "replacement tombstone during stable read fences mutation");
	fixture.doc.destroy();
}

// Keep-local has already revived CRDT when it performs asynchronous baseline
// hashing. A second delete in that window must retain its replacement marker.
{
	let fixture!: ReturnType<typeof makeFixture>;
	fixture = makeFixture({
		onBaselineDiskRead: () => {
			fixture.replaceAttentionEpisode("episode-2");
		},
	});
	await assert.rejects(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
			expectedEpisode,
		),
		/Attention state changed|Local state changed before the baseline settled/,
	);
	assert.equal(fixture.ensureCalls, 1, "Keep-local published before the second delete arrived");
	assert.equal(fixture.clearCalls, 0, "the replacement marker is not cleared");
	assert.equal(fixture.attentionEpisodeId, "episode-2", "the replacement episode remains actionable");
	fixture.doc.destroy();
}

// Reviving the CRDT is not enough to resolve Attention. The exact disk TFile
// reviewed by the action must still own the path after the baseline read.
{
	let fixture!: ReturnType<typeof makeFixture>;
	fixture = makeFixture({
		onBaselineDiskRead: () => { fixture.replaceActiveFileSameBytes(); },
	});
	await ignoreResolutionFailure(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
			expectedEpisode,
		),
	);
	assert.equal(fixture.ensureCalls, 1, "TFile ABA occurs after keep-local publishes the reviewed bytes");
	assert.equal(fixture.clearCalls, 0, "same-path/same-bytes TFile ABA retains the marker");
	assert.equal(fixture.attentionEpisodeId, "episode-1", "TFile ABA leaves the exact episode actionable");
	assert.equal(fixture.baselineRecordCalls, 0, "TFile ABA cannot publish a settled baseline");
	fixture.doc.destroy();
}

// A failed durable save makes updateDiskIndexForPath return false even though
// its in-memory bookkeeping ran. Attention must remain until a later exact
// settlement can prove durability.
{
	const fixture = makeFixture({
		saveDiskIndex: async () => { throw new Error("disk-index save failed"); },
	});
	await ignoreResolutionFailure(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
			expectedEpisode,
		),
	);
	assert.equal(fixture.ensureCalls, 1, "save-failure scenario reaches keep-local publication");
	assert.equal(fixture.clearCalls, 0, "failed disk-index save retains the marker");
	assert.equal(fixture.attentionEpisodeId, "episode-1", "save failure leaves the episode actionable");
	fixture.doc.destroy();
}

// A baseline read failure is also an unresolved settlement, never permission
// to clear the episode whose local bytes could not be re-verified.
{
	const fixture = makeFixture({ failBaselineDiskRead: true });
	await ignoreResolutionFailure(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
			expectedEpisode,
		),
	);
	assert.equal(fixture.ensureCalls, 1, "read-failure scenario reaches keep-local publication");
	assert.equal(fixture.clearCalls, 0, "failed baseline read retains the marker");
	assert.equal(fixture.attentionEpisodeId, "episode-1", "read failure leaves the episode actionable");
	assert.equal(fixture.baselineRecordCalls, 0, "failed baseline read publishes no baseline");
	fixture.doc.destroy();
}

// A provider transaction can advance the just-revived Y.Text while baseline
// settlement is awaiting disk I/O. The local baseline must not authorize
// clearing Attention for that different CRDT state.
{
	const providerContent = "new provider content during baseline read\n";
	let fixture!: ReturnType<typeof makeFixture>;
	fixture = makeFixture({
		onBaselineDiskRead: () => { fixture.replaceCrdtContent(providerContent); },
	});
	await ignoreResolutionFailure(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
			expectedEpisode,
		),
	);
	assert.equal(fixture.ytext.toString(), providerContent, "provider update wins the baseline-read interleaving");
	assert.equal(fixture.clearCalls, 0, "CRDT advance during baseline settlement retains the marker");
	assert.equal(fixture.attentionEpisodeId, "episode-1", "CRDT advance leaves the episode actionable");
	fixture.doc.destroy();
}

// The remote can revive while the local stable read is awaiting I/O. The
// post-await authoritative check must observe that change before ensureFile.
{
	let fixture!: ReturnType<typeof makeFixture>;
	fixture = makeFixture({
		readStable: async (_path, _reason, ready) => {
			fixture.setDeletedPath(false);
			fixture.setActiveFileIds(["remote-revival"]);
			return ready;
		},
	});
	await assert.rejects(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
		),
		/Remote deletion is no longer active/,
	);
	assert.equal(fixture.ensureCalls, 0, "remote revival during stable read fences CRDT mutation");
	assert.equal(fixture.clearCalls, 0, "remote revival preserves the Attention marker");
	fixture.doc.destroy();
}

// Keep and Accept cannot own the same path concurrently.
{
	const readStarted = deferred<void>();
	const allowRead = deferred<void>();
	const fixture = makeFixture({
		readStable: async (_path, _reason, ready) => {
			readStarted.resolve();
			await allowRead.promise;
			return ready;
		},
	});
	const keeping = fixture.controller.keepLocalRemoteDeletedMarkdown(
		fixture.path,
		"remote-delete-missing-baseline",
	);
	await readStarted.promise;
	await assert.rejects(
		fixture.controller.beginAcceptRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
		),
		/Another Attention action is already running/,
	);
	allowRead.resolve();
	await keeping;
	assert.equal(fixture.ensureCalls, 1, "the original resolution remains the sole writer");
	fixture.doc.destroy();
}

// An already-active local create that is waiting on its stable read must not
// reach ensureFile after Accept obtains its lease. Queued work is dropped too.
{
	const ingestReadStarted = deferred<void>();
	const allowIngestRead = deferred<void>();
	const fixture = makeFixture({
		readStable: async (_path, reason, ready) => {
			if (reason === "create") {
				ingestReadStarted.resolve();
				await allowIngestRead.promise;
			}
			return ready;
		},
	});
	assert.ok(fixture.diskPort, "fixture exposes the deterministic ingest port");
	const activeCreate = fixture.diskPort!.ingestDiskFileNow(fixture.path, "create");
	await ingestReadStarted.promise;
	fixture.controller.markMarkdownDirty(fixture.file, "create", "op-queued-create");

	const lease = await fixture.controller.beginAcceptRemoteDeletedMarkdown(
		fixture.path,
		"remote-delete-missing-baseline",
	);
	try {
		fixture.controller.markMarkdownDirty(fixture.file, "create", "op-during-accept");
		allowIngestRead.resolve();
		await activeCreate;
		assert.equal(fixture.ensureCalls, 0, "active create aborts before ensureFile");
		assert.equal(
			(fixture.controller as any).dirtyMarkdownPaths.has(fixture.path),
			false,
			"Accept drops queued and newly observed dirty work for its path",
		);
	} finally {
		fixture.controller.finishRemoteDeletedMarkdownResolution(lease);
	}
	fixture.doc.destroy();
}

// Accept performs the same unsaved-editor authority check before granting a
// lease that authorizes local deletion.
{
	const fixture = makeFixture({ editorContent: "newer unsaved editor text\n" });
	await assert.rejects(
		fixture.controller.beginAcceptRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
		),
		/unsaved changes/,
	);
	assert.equal(fixture.ensureCalls, 0, "unsaved editor does not grant an Accept lease");
	fixture.doc.destroy();
}

// An open Base is an opaque file authority: Accept must leave the Attention
// entry untouched until the view closes, after which the user can explicitly
// retry the same action and obtain a fresh lease.
{
	const fixture = makeFixture({
		path: "BACKLOG/BACKLOG.base",
		opaqueOpenFileView: true,
	});
	await assert.rejects(
		fixture.controller.beginAcceptRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
			expectedEpisode,
		),
		/file view.*still open.*Close it/i,
	);
	assert.equal(fixture.attentionEpisodeId, "episode-1", "open Base keeps its remote-delete Attention episode");

	fixture.setOpaqueOpenFileView(false);
	const lease = await fixture.controller.beginAcceptRemoteDeletedMarkdown(
		fixture.path,
		"remote-delete-missing-baseline",
		expectedEpisode,
	);
	fixture.controller.finishRemoteDeletedMarkdownResolution(lease);
	assert.equal(fixture.attentionEpisodeId, "episode-1", "granting a post-close lease does not clear Attention before trash");
	fixture.doc.destroy();
}

// main.ts must repeat the opaque-view fence after acquiring the lease and
// immediately before the destructive trash boundary. This protects a Base
// view that opens while the dashboard action is in flight.
{
	const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
	const resolveStart = mainSource.indexOf("private async resolveRemoteDeleteAttention(");
	const leaseStart = mainSource.indexOf("beginAcceptRemoteDeletedMarkdown(", resolveStart);
	const finalOpaqueFence = mainSource.indexOf(
		"assertNoOpaqueOpenFileViewForRemoteDelete(",
		leaseStart,
	);
	const trashStart = mainSource.indexOf("await this.app.fileManager.trashFile(file)", finalOpaqueFence);
	assert.ok(
		resolveStart >= 0
			&& leaseStart > resolveStart
			&& finalOpaqueFence > leaseStart
			&& trashStart > finalOpaqueFence,
		"dashboard Accept rechecks opaque file views after its lease and before trashFile",
	);
}

console.log("PASS Markdown Attention resolution fencing");
