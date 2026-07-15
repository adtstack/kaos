import assert from "node:assert/strict";
import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import { BlobSyncManager } from "../src/sync/blobSync";
import {
	PreservedUnresolvedRegistry,
	isRemoteDeletePreservedUnresolvedEntry,
} from "../src/sync/preservedUnresolved";

class FakeTFile extends TFile {
	constructor(
		readonly path: string,
		readonly stat: { mtime: number; size: number },
	) {
		super();
	}
}

interface FixtureOptions {
	ensureSucceeds?: boolean;
	frontmatterBlocked?: boolean;
	syncable?: boolean;
	maxFileSizeBytes?: number;
	editorContent?: string;
}

function makeMarkdownFixture(options: FixtureOptions = {}) {
	const path = "notes/keep-local.md";
	const content = "local content wins\n";
	const file = new FakeTFile(path, { mtime: 42, size: content.length });
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "remote race content\n");
	let tombstoned = true;
	let entries = [{
		path,
		kind: "markdown" as const,
		reason: "remote-delete-missing-baseline" as const,
		firstSeenAt: 1,
		lastSeenAt: 2,
	}];
	let diskIndex = {};
	let ensureOptions: { reviveTombstone?: boolean; reviveReason?: string; opId?: string } | undefined;
	let saved = 0;
	let reconciled = 0;
	let clearCalls = 0;
	let ensureCalls = 0;
	const editorContent = options.editorContent;
	const openView = editorContent === undefined
		? null
		: Object.assign(new MarkdownView(), {
			file,
			editor: { getValue: () => editorContent },
		});

	const vaultSync = {
		isMarkdownTombstoned: (candidate: string) => candidate === path && tombstoned,
		// A tombstoned path has no active text, but ensureFile publishes the
		// revived Y.Text as the current path authority before baseline commit.
		getTextForPath: () => tombstoned ? null : ytext,
		serverAckTracker: {
			withActiveOpId: (_opId: string | undefined, work: () => unknown) => work(),
		},
		ensureFile: (
			_candidate: string,
			_currentContent: string,
			_device?: string,
			optionsArg?: { reviveTombstone?: boolean; reviveReason?: string; opId?: string },
		) => {
			ensureCalls++;
			ensureOptions = optionsArg;
			if (options.ensureSucceeds === false) return null;
			tombstoned = false;
			return ytext;
		},
	};
	const diskMirror = {
		getPreservedUnresolvedEntries: () => entries,
		clearPreservedUnresolved: (candidate: string) => {
			clearCalls++;
			entries = entries.filter((entry) => entry.path !== candidate);
		},
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
		getSettings: () => ({ deviceName: "dashboard-device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: options.maxFileSizeBytes ?? 0,
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
		recordBaselineText: () => {},
		isMarkdownPathSyncable: () => options.syncable !== false,
		shouldBlockFrontmatterIngest: () => options.frontmatterBlocked === true,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => { reconciled++; },
		readStableMarkdownFile: async () => ({
			kind: "ready" as const,
			file,
			content,
			stat: file.stat,
		}),
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => { saved++; },
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	return {
		controller,
		doc,
		path,
		content,
		ytext,
		get entries() { return entries; },
		get ensureOptions() { return ensureOptions; },
		get saved() { return saved; },
		get reconciled() { return reconciled; },
		get clearCalls() { return clearCalls; },
		get ensureCalls() { return ensureCalls; },
	};
}

console.log("\n--- Dashboard attention resolution ---");

assert.equal(
	isRemoteDeletePreservedUnresolvedEntry({
		kind: "markdown",
		reason: "remote-delete-missing-baseline",
	}),
	true,
	"valid Markdown remote-delete reason is actionable",
);
assert.equal(
	isRemoteDeletePreservedUnresolvedEntry({
		kind: "markdown",
		reason: "remote-delete-hash-read-failed",
	}),
	false,
	"blob-only remote-delete reason is not actionable for Markdown",
);
assert.equal(
	isRemoteDeletePreservedUnresolvedEntry({
		kind: "blob",
		reason: "remote-delete-stat-failed",
	}),
	true,
	"valid blob remote-delete reason is actionable",
);
assert.equal(
	isRemoteDeletePreservedUnresolvedEntry({
		kind: "blob",
		reason: "remote-delete-trash-failed",
	}),
	true,
	"visible-backup failure remains actionable for blobs",
);

{
	const fixture = makeMarkdownFixture();
	await fixture.controller.keepLocalRemoteDeletedMarkdown(
		fixture.path,
		"remote-delete-missing-baseline",
	);
	assert.equal(fixture.ensureOptions?.reviveTombstone, true, "Keep local explicitly revives the tombstone");
	assert.equal(fixture.ensureOptions?.reviveReason, "dashboard-keep-local", "Keep local records the dashboard reason");
	assert.equal(fixture.ytext.toString(), fixture.content, "local content replaces a racing remote value");
	assert.equal(fixture.entries.length, 0, "attention marker clears after local content is published");
	assert.equal(fixture.clearCalls, 1, "attention marker is cleared once");
	assert.equal(fixture.saved, 1, "updated disk baseline is persisted");
	assert.equal(fixture.reconciled, 1, "editor/runtime bindings are refreshed");
	fixture.doc.destroy();
}

{
	const fixture = makeMarkdownFixture({ ensureSucceeds: false });
	await assert.rejects(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
		),
		/Failed to publish/,
	);
	assert.equal(fixture.entries.length, 1, "failed revive keeps the attention marker");
	assert.equal(fixture.clearCalls, 0, "failed revive does not clear the marker");
	fixture.doc.destroy();
}

{
	const fixture = makeMarkdownFixture({ frontmatterBlocked: true });
	await assert.rejects(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
		),
		/quarantined/,
	);
	assert.equal(fixture.ensureCalls, 0, "frontmatter quarantine blocks the revive before mutation");
	assert.equal(fixture.entries.length, 1, "frontmatter quarantine keeps the attention marker");
	fixture.doc.destroy();
}

{
	const fixture = makeMarkdownFixture({ editorContent: "newer unsaved editor content\n" });
	await assert.rejects(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
		),
		/unsaved changes/,
	);
	assert.equal(fixture.ensureCalls, 0, "unsaved editor content blocks revive before mutation");
	assert.equal(fixture.entries.length, 1, "unsaved editor content keeps the attention marker");
	fixture.doc.destroy();
}

{
	const fixture = makeMarkdownFixture({ syncable: false });
	await assert.rejects(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
		),
		/no longer in sync scope/,
	);
	assert.equal(fixture.ensureCalls, 0, "excluded Markdown path is not revived");
	assert.equal(fixture.entries.length, 1, "excluded Markdown path keeps the attention marker");
	fixture.doc.destroy();
}

{
	const fixture = makeMarkdownFixture({ maxFileSizeBytes: 1 });
	await assert.rejects(
		fixture.controller.keepLocalRemoteDeletedMarkdown(
			fixture.path,
			"remote-delete-missing-baseline",
		),
		/exceeds the configured size limit/,
	);
	assert.equal(fixture.ensureCalls, 0, "oversized Markdown file is not revived");
	assert.equal(fixture.entries.length, 1, "oversized Markdown file keeps the attention marker");
	fixture.doc.destroy();
}

{
	const path = "assets/keep-local.png";
	const file = new FakeTFile(path, { mtime: 9, size: 128 });
	const registry = new PreservedUnresolvedRegistry([{
		path,
		kind: "blob",
		reason: "remote-delete-missing-baseline",
		firstSeenAt: 1,
		lastSeenAt: 2,
	}]);
	let changed = 0;
	let kicked = 0;
	const manager = Object.create(BlobSyncManager.prototype) as any;
	manager.preservedUnresolved = registry;
	manager.preservedUnresolvedPaths = registry.paths;
	let tombstoned = true;
	manager.vaultSync = {
		isBlobTombstoned: () => tombstoned,
		blobTombstones: { delete: () => { tombstoned = false; } },
	};
	manager.isBlobPathSyncable = () => true;
	manager.app = { vault: { getAbstractFileByPath: () => file } };
	manager.maxSize = 1024;
	manager.onPreservedUnresolvedChanged = () => { changed++; };
	manager.trace = () => {};
	manager.uploadQueue = new Map();
	manager.settlementStages = {};
	manager.kickUploadDrain = () => { kicked++; };

	manager.keepLocalRemoteDeletedBlob(path, "remote-delete-missing-baseline");
	assert.equal(tombstoned, true, "blob Keep local retains the tombstone until upload commit");
	assert.equal(registry.has(path), true, "blob Keep local retains the marker until upload commit");
	assert.equal(manager.uploadQueue.has(path), true, "blob Keep local queues the local attachment for upload");
	assert.equal(
		manager.uploadQueue.get(path)?.attentionResolution?.kind,
		"keep-local-remote-delete",
		"blob Keep local queues an explicit resolution intent",
	);
	assert.equal(changed, 0, "blob Keep local does not persist a false early resolution");
	assert.equal(kicked, 1, "blob Keep local starts the upload drain");
}

{
	const path = "assets/stale.png";
	const file = new FakeTFile(path, { mtime: 9, size: 128 });
	const registry = new PreservedUnresolvedRegistry([{
		path,
		kind: "blob",
		reason: "remote-delete-missing-baseline",
		firstSeenAt: 1,
		lastSeenAt: 2,
	}]);
	const manager = Object.create(BlobSyncManager.prototype) as any;
	manager.preservedUnresolved = registry;
	manager.vaultSync = { isBlobTombstoned: () => false };
	manager.isBlobPathSyncable = () => true;
	manager.app = { vault: { getAbstractFileByPath: () => file } };
	manager.maxSize = 1024;

	assert.throws(
		() => manager.keepLocalRemoteDeletedBlob(path, "remote-delete-missing-baseline"),
		/Remote deletion is no longer authoritative/,
	);
	assert.equal(registry.has(path), true, "stale blob action keeps the attention marker");
}

console.log("PASS dashboard attention resolution");
