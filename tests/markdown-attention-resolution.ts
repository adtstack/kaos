import assert from "node:assert/strict";
import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import {
	ReconciliationController,
	type StableMarkdownReadResult,
} from "../src/runtime/reconciliationController";
import type { DiskIngestPort } from "../src/runtime/engineControlPort";

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
	readStable?: (
		path: string,
		reason: "create" | "modify",
		ready: StableMarkdownReadResult,
	) => Promise<StableMarkdownReadResult>;
	editorContent?: string;
	onRecordBaselineText?: () => void;
}

function makeFixture(options: FixtureOptions = {}) {
	const path = "notes/attention-fence.md";
	const content = "local preserved content\n";
	const file = new FakeTFile(path, { mtime: 41, size: content.length });
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
	let diskPort: DiskIngestPort | null = null;
	let diskIndex = {};
	const openView = options.editorContent === undefined
		? null
		: Object.assign(new MarkdownView(), {
			file,
			editor: { getValue: () => options.editorContent! },
		});

	const vaultSync = {
		isPathTombstoned: (candidate: string) => candidate === path && deletedPath,
		isMarkdownTombstoned: (candidate: string) => candidate === path && deletedPath,
		getAuthoritativeMarkdownDeleteSnapshot: (candidate: string) =>
			candidate === path && deletedPath && activeFileIds.length === 0
				? { fingerprint: deleteFingerprint }
				: null,
		getActiveFileIdsForPath: (candidate: string) => candidate === path ? [...activeFileIds] : [],
		getTextForPath: () => null,
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
				getAbstractFileByPath: (candidate: string) => candidate === path ? file : null,
				read: async () => content,
				adapter: { stat: async () => file.stat },
			},
			workspace: {
				getActiveViewOfType: () => openView,
				iterateAllLeaves: () => {},
			},
		} as any,
		getSettings: () => ({ deviceName: "attention-test" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => diskMirror as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
		recordBaselineText: () => options.onRecordBaselineText?.(),
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
		saveDiskIndex: async () => {},
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
		setDeletedPath(value: boolean) { deletedPath = value; },
		setDeleteFingerprint(value: string) { deleteFingerprint = value; },
		setActiveFileIds(value: string[]) { activeFileIds = [...value]; },
		replaceAttentionEpisode(episodeId: string) {
			if (entry) entry = { ...entry, episodeId, lastSeenAt: entry.lastSeenAt + 1 };
		},
		get attentionEpisodeId() { return entry?.episodeId ?? null; },
	};
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
		onRecordBaselineText: () => {
			fixture.replaceAttentionEpisode("episode-2");
		},
	});
	await assert.rejects(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
			expectedEpisode,
		),
		/Attention state changed/,
	);
	assert.equal(fixture.ensureCalls, 1, "Keep-local published before the second delete arrived");
	assert.equal(fixture.clearCalls, 0, "the replacement marker is not cleared");
	assert.equal(fixture.attentionEpisodeId, "episode-2", "the replacement episode remains actionable");
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

console.log("PASS Markdown Attention resolution fencing");
