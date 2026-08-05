import { createHash } from "node:crypto";
import * as Y from "yjs";
import { MarkdownView, TFile } from "obsidian";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import type { DiskIngestPort } from "../src/runtime/engineControlPort";
import { DiskMirror } from "../src/sync/diskMirror";
import type { InterceptedExternalDiskMutation } from "../src/sync/editorBinding";
import { ORIGIN_OPEN_EXTERNAL_EDIT_MERGE } from "../src/sync/origins";
import { ServerAckTracker } from "../src/sync/serverAckTracker";
import { InMemoryCandidateStore, type ScopeKey, type ScopeMetadata } from "../src/sync/candidateStore";
import type { TraceEventDetails } from "../src/telemetry/debug/trace";

Object.defineProperty(globalThis, "__KAOS_QA_HARNESS_ENABLED__", {
	configurable: true,
	value: false,
});

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

interface CapturedTrace {
	source: string;
	msg: string;
	details?: TraceEventDetails;
}

function captureTrace(events: CapturedTrace[]) {
	return (source: string, msg: string, details?: TraceEventDetails) => {
		events.push({ source, msg, details });
	};
}

function findEvent(events: CapturedTrace[], source: string, msg: string): CapturedTrace | undefined {
	return events.find((event) => event.source === source && event.msg === msg);
}

/**
 * Production remote-delete handling is admitted by an exact tombstone episode,
 * not merely by a direct call to the private handler. Keep the focused trace
 * fixtures honest by exposing the same authoritative snapshot contract.
 */
function makeMarkdownDeleteEpisode(path: string) {
	let tombstoned = true;
	const fingerprint = `trace-markdown-delete:${path}`;
	return {
		vaultSyncFields: {
			getAuthoritativeMarkdownDeleteSnapshot: (candidate: string) => (
				tombstoned && candidate === path ? { fingerprint } : null
			),
			getActiveFileIdsForPath: (candidate: string) => (
				!tombstoned && candidate === path ? ["active-file"] : []
			),
			isPathTombstoned: (candidate: string) => tombstoned && candidate === path,
		},
		revive: () => {
			tombstoned = false;
		},
		isTombstoned: () => tombstoned,
	};
}

const CLOSED_PATH_EDITOR_AUTHORITY = {
	capturePathEditorAuthority: () => ({ kind: "none" as const }),
	isPathEditorAuthorityLeaseCurrent: () => false,
};

const BASE_SCOPE: ScopeKey & ScopeMetadata = {
	vaultIdHash: "vault-hash",
	serverHostHash: "host-hash",
	localDeviceId: "local-device",
	roomName: "raw-room-name-should-not-leak",
	docSchemaVersion: 2,
	pluginVersion: "0.5.0",
	ackStoreVersion: 1,
};

console.log("\n--- Test 1: receipt trace events fire from tracker behavior ---");
{
	const events: CapturedTrace[] = [];
	const doc = new Y.Doc({ gc: false });
	const provider = { kind: "provider" };
	const tracker = new ServerAckTracker(captureTrace(events));
	tracker.attach(doc, () => Y.encodeStateVector(doc), provider, null);
	await tracker.onStartup(new InMemoryCandidateStore(), BASE_SCOPE);

	doc.getText("note").insert(0, "hello");
	tracker.recordServerSvEcho(Y.encodeStateVector(doc));

	const captured = findEvent(events, "receipt", "receipt-candidate-captured");
	const echo = findEvent(events, "receipt", "receipt-server-echo");
	assert(!!captured, "local update emits receipt-candidate-captured");
	assert(captured?.details?.candidateBytes !== undefined, "candidate trace includes byte count");
	assert(!!echo, "server echo emits receipt-server-echo");
	assert(echo?.details?.serverDominatesCandidate === true, "echo trace reports domination result");
	assert(echo?.details?.serverAppliedLocalState === true, "echo trace reports tracker state");
}

console.log("\n--- Test 2: receipt startup failure trace does not leak room name ---");
{
	const events: CapturedTrace[] = [];
	const tracker = new ServerAckTracker(captureTrace(events));
	await tracker.onStartup({
		async load() {
			throw new Error("load failed");
		},
		async save() {},
		async clear() {},
	}, BASE_SCOPE);

	const failedLoad = findEvent(events, "receipt", "receipt-startup-load-failed");
	const serialized = JSON.stringify(failedLoad);
	assert(!!failedLoad, "startup load failure emits receipt-startup-load-failed");
	assert(!serialized.includes(BASE_SCOPE.roomName), "startup load failure trace does not include raw room name");
}

function makeSuppressionMirror(
	readContent: () => string | Promise<string>,
	events: CapturedTrace[],
	vaultReadContent: () => string | Promise<string> = readContent,
): DiskMirror {
	const app = {
		vault: {
			read: async () => vaultReadContent(),
			adapter: {
				read: async () => readContent(),
			},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		getTextForPath: () => null,
		isFileMetaDeleted: () => false,
	} as any;
	const editorBindings = {
		...CLOSED_PATH_EDITOR_AUTHORITY,
		getLastEditorActivityForPath: () => null,
	} as any;
	return new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));
}

console.log("\n--- Test 3: suppression acknowledgement trace fires from observed file state ---");
{
	const events: CapturedTrace[] = [];
	const mirror = makeSuppressionMirror(() => "expected", events);
	await (mirror as any).suppressWrite("Notes/suppressed.md", "expected");
	const file = new TFile() as TFile & { path: string; stat: { size: number } };
	file.path = "Notes/suppressed.md";
	file.stat = { size: new TextEncoder().encode("expected").length };

	const suppressed = await mirror.shouldSuppressModify(file);
	const acknowledged = findEvent(events, "disk", "suppression-acknowledged");
	assert(suppressed, "matching observed state suppresses self modify event");
	assert(!!acknowledged, "matching observed state emits suppression-acknowledged");
	assert(acknowledged?.details?.path === "Notes/suppressed.md", "suppression trace includes path field for redaction");
}

console.log("\n--- Test 4: suppression mismatch trace fires from changed file state ---");
{
	const events: CapturedTrace[] = [];
	const mirror = makeSuppressionMirror(() => "changed", events);
	await (mirror as any).suppressWrite("Notes/suppressed.md", "expected");
	const file = new TFile() as TFile & { path: string; stat: { size: number } };
	file.path = "Notes/suppressed.md";
	file.stat = { size: new TextEncoder().encode("changed").length };

	const suppressed = await mirror.shouldSuppressModify(file);
	const mismatch = findEvent(events, "disk", "suppression-mismatch");
	assert(!suppressed, "changed observed state does not suppress modify event");
	assert(!!mismatch, "changed observed state emits suppression-mismatch");
	assert(mismatch?.details?.reason === "size-mismatch", "suppression mismatch includes reason");
}

console.log("\n--- Test 4a: same-path adoption holds projection before Y.Text read ---");
{
	const mirror = makeSuppressionMirror(() => "disk", []);
	mirror.setSamePathAdoptionProjectionHoldPredicate(() => true);
	const held = await mirror.flushWrite("Notes/adoption-held.md", true);
	assert(
		held.kind === "deferred" && held.reason === "same-path-adoption-active",
		"ordinary forced projection is held while adoption is active",
	);
	const exactSettlement = await mirror.flushWrite("Notes/adoption-held.md", true, {
		isSamePathAdoptionSettlementCurrent: () => true,
	});
	assert(
		exactSettlement.kind === "deferred" && exactSettlement.reason === "missing-ytext",
		"the exact settlement capability crosses only the adoption hold",
	);
}

console.log("\n--- Test 4a2: queued projection rechecks the hold under the path lock ---");
{
	const mirror = makeSuppressionMirror(() => "disk", []);
	let held = false;
	mirror.setSamePathAdoptionProjectionHoldPredicate(() => held);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const blocker = (mirror as unknown as {
		runPathWriteLocked(path: string, work: () => Promise<void>): Promise<void>;
	}).runPathWriteLocked("Notes/queued-adoption.md", () => gate);
	const queued = mirror.flushWrite("Notes/queued-adoption.md", true);
	held = true;
	release();
	await blocker;
	const result = await queued;
	assert(
		result.kind === "deferred" && result.reason === "same-path-adoption-active",
		"work admitted before adoption cannot cross the later under-lock hold",
	);
}

console.log("\n--- Test 4b: recent self-write fingerprint probe is exact and non-consuming ---");
{
	let diskContent = "expected";
	const events: CapturedTrace[] = [];
	const mirror = makeSuppressionMirror(() => diskContent, events);
	await (mirror as any).suppressWrite("Notes/suppressed.md", "expected");
	const file = new TFile() as TFile & { path: string; stat: { size: number } };
	file.path = "Notes/suppressed.md";
	file.stat = { size: new TextEncoder().encode(diskContent).length };

	assert(
		await mirror.matchesRecentWriteFingerprint(file) === true,
		"matching recent bytes prove the modify is KAOS's self-write",
	);
	assert(
		mirror.isSuppressed(file.path),
		"fingerprint probe does not consume the normal reconciliation suppressor",
	);

	diskContent = "external";
	file.stat = { size: new TextEncoder().encode(diskContent).length };
	assert(
		await mirror.matchesRecentWriteFingerprint(file) === false,
		"same-size external bytes are not hidden by the timing suppression window",
	);
	assert(
		mirror.isSuppressed(file.path),
		"mismatch probe also leaves definitive suppression handling to reconciliation",
	);
}

console.log("\n--- Test 4c: fingerprint proof cannot cross a file revision change ---");
{
	let releaseRead: (() => void) | null = null;
	const readGate = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	let diskContent = "external";
	const events: CapturedTrace[] = [];
	const mirror = makeSuppressionMirror(async () => {
		await readGate;
		return diskContent;
	}, events);
	await (mirror as any).suppressWrite("Notes/revision-race.md", "expected");
	const file = new TFile() as TFile & {
		path: string;
		stat: { ctime: number; mtime: number; size: number };
	};
	file.path = "Notes/revision-race.md";
	file.stat = { ctime: 1, mtime: 10, size: 8 };

	const probe = mirror.probeRecentWriteFingerprint(file, {
		path: file.path,
		ctime: 1,
		mtime: 10,
		size: 8,
	});
	// The event represented external bytes, but a later same-size revision now
	// contains KAOS's expected bytes before the asynchronous read completes.
	diskContent = "expected";
	file.stat = { ctime: 1, mtime: 11, size: 8 };
	releaseRead?.();

	assert(
		(await probe).kind === "stale",
		"later same-size bytes cannot prove that the older modify event was a self-write",
	);
	assert(
		mirror.isSuppressed(file.path),
		"stale revision probe leaves definitive suppression state untouched",
	);
}

console.log("\n--- Test 4d: exact revision reads preserve raw UTF-8, BOM, and mixed EOL bytes ---");
{
	const rawContent = "\ufeff한글\r\nline two\n";
	const events: CapturedTrace[] = [];
	const mirror = makeSuppressionMirror(
		() => rawContent,
		events,
		// Obsidian's Vault.read strips a UTF-8 BOM. The adapter is the exact
		// representation boundary used by the modify event proof.
		() => rawContent.slice(1),
	);
	const rawBytes = new TextEncoder().encode(rawContent).byteLength;
	const file = new TFile() as TFile & {
		path: string;
		stat: { ctime: number; mtime: number; size: number };
	};
	file.path = "Notes/raw-revision.md";
	file.stat = { ctime: 2, mtime: 20, size: rawBytes };

	const observed = await mirror.readExactObservedDiskRevision(file, {
		path: file.path,
		ctime: 2,
		mtime: 20,
		size: rawBytes,
	});
	assert(observed === rawContent, "exact revision read returns the unchanged raw text representation");
}

console.log("\n--- Test 5: diskMirror remote delete emits trace with deleteMode ---");
{
	const events: CapturedTrace[] = [];
	const trashedPaths: string[] = [];
	const deletedPaths: string[] = [];

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/remote-deleted.md";
	file.stat = { mtime: 1, size: 10 };

	const fileContent = "content";
	let filePresent = true;
	const deleteEpisode = makeMarkdownDeleteEpisode(file.path);
	const app = {
		vault: {
			read: async () => fileContent,
			getAbstractFileByPath: (path: string) => (
				filePresent && path === "Notes/remote-deleted.md" ? file : null
			),
			delete: async (f: TFile) => { deletedPaths.push(f.path); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async (f: TFile & { path: string }) => {
				trashedPaths.push(f.path);
				filePresent = false;
			},
		},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// CRDT matches disk content — file is clean, delete should proceed
		getTextForPath: () => ({ toString: () => fileContent }),
		isFileMetaDeleted: () => false,
		...deleteEpisode.vaultSyncFields,
	} as any;
	const editorBindings = {
		...CLOSED_PATH_EDITOR_AUTHORITY,
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await (mirror as any).handleRemoteDelete(
		"Notes/remote-deleted.md",
		{ baselineText: fileContent },
	);

	const deleteApplied = findEvent(events, "disk", "remote-delete-applied");
	assert(!!deleteApplied, "diskMirror remote delete emits remote-delete-applied trace");
	assert(deleteApplied?.details?.deleteMode === "trash", "diskMirror remote delete reports deleteMode 'trash'");
	assert(trashedPaths.includes("Notes/remote-deleted.md"), "diskMirror remote delete uses trashFile");
	assert(deletedPaths.length === 0, "diskMirror does not hard-delete when trash available");
}

console.log("\n--- Test 6: diskMirror remote delete falls back to recoverable vault trash ---");
{
	const events: CapturedTrace[] = [];
	const deletedPaths: string[] = [];
	const vaultTrashedPaths: string[] = [];

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/fallback-deleted.md";
	file.stat = { mtime: 1, size: 10 };

	const fileContent = "content";
	let filePresent = true;
	const deleteEpisode = makeMarkdownDeleteEpisode(file.path);
	const app = {
		vault: {
			read: async () => fileContent,
			getAbstractFileByPath: (path: string) => (
				filePresent && path === "Notes/fallback-deleted.md" ? file : null
			),
			trash: async (f: TFile & { path: string }) => {
				vaultTrashedPaths.push(f.path);
				filePresent = false;
			},
			delete: async (f: TFile & { path: string }) => { deletedPaths.push(f.path); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		// No fileManager — trash unavailable
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// CRDT matches disk content — file is clean, delete should proceed
		getTextForPath: () => ({ toString: () => fileContent }),
		isFileMetaDeleted: () => false,
		...deleteEpisode.vaultSyncFields,
	} as any;
	const editorBindings = {
		...CLOSED_PATH_EDITOR_AUTHORITY,
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await (mirror as any).handleRemoteDelete(
		"Notes/fallback-deleted.md",
		{ baselineText: fileContent },
	);

	const deleteApplied = findEvent(events, "disk", "remote-delete-applied");
	assert(!!deleteApplied, "diskMirror fallback delete emits remote-delete-applied trace");
	assert(deleteApplied?.details?.deleteMode === "trash", "diskMirror fallback reports recoverable trash mode");
	assert(vaultTrashedPaths.includes("Notes/fallback-deleted.md"), "diskMirror falls back to vault.trash");
	assert(deletedPaths.length === 0, "diskMirror never falls back to hard delete");
}

console.log("\n--- Test 7: diskMirror remote delete preserves locally modified markdown ---");
{
	const events: CapturedTrace[] = [];
	const trashedPaths: string[] = [];

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/locally-modified.md";
	file.stat = { mtime: 1, size: 20 };
	const baselineContent = "old CRDT version";
	let activeContent = baselineContent;
	const activeText = { toString: () => activeContent, toJSON: () => activeContent };
	const deleteEpisode = makeMarkdownDeleteEpisode(file.path);

	const app = {
		vault: {
			read: async () => "locally edited version",
			getAbstractFileByPath: (path: string) => (path === "Notes/locally-modified.md" ? file : null),
			delete: async () => { throw new Error("should not delete locally modified file"); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async () => { throw new Error("should not trash locally modified file"); },
		},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		getTextForPath: () => activeText,
		isFileMetaDeleted: () => false,
		ensureFile: (_path: string, content: string) => {
			activeContent = content;
			deleteEpisode.revive();
			return { kind: "created" as const, fileId: "active-file", ytext: activeText };
		},
		...deleteEpisode.vaultSyncFields,
	} as any;
	const editorBindings = {
		...CLOSED_PATH_EDITOR_AUTHORITY,
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await (mirror as any).handleRemoteDelete(
		"Notes/locally-modified.md",
		{ baselineText: baselineContent },
	);

	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	const deleted = findEvent(events, "disk", "remote-delete-applied");
	assert(!!preserved, "diskMirror preserves locally modified file");
	assert(preserved?.details?.reason === "local-file-modified-since-last-sync", "trace includes correct reason");
	assert(!deleted, "diskMirror does NOT delete locally modified file");
}

console.log("\n--- Test 8: diskMirror remote delete proceeds when content matches CRDT ---");
{
	const events: CapturedTrace[] = [];
	const trashedPaths: string[] = [];

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/unchanged.md";
	file.stat = { mtime: 1, size: 10 };

	const matchingContent = "content matches CRDT";
	let filePresent = true;
	const deleteEpisode = makeMarkdownDeleteEpisode(file.path);
	const app = {
		vault: {
			read: async () => matchingContent,
			getAbstractFileByPath: (path: string) => (
				filePresent && path === "Notes/unchanged.md" ? file : null
			),
			delete: async () => {},
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async (f: TFile & { path: string }) => {
				trashedPaths.push(f.path);
				filePresent = false;
			},
		},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// Return CRDT content that MATCHES disk content
		getTextForPath: () => ({ toString: () => matchingContent }),
		isFileMetaDeleted: () => false,
		...deleteEpisode.vaultSyncFields,
	} as any;
	const editorBindings = {
		...CLOSED_PATH_EDITOR_AUTHORITY,
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await (mirror as any).handleRemoteDelete(
		"Notes/unchanged.md",
		{ baselineText: matchingContent },
	);

	const deleted = findEvent(events, "disk", "remote-delete-applied");
	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	assert(!!deleted, "diskMirror deletes file when disk content matches CRDT");
	assert(!preserved, "diskMirror does NOT preserve file when content matches");
	assert(trashedPaths.includes("Notes/unchanged.md"), "diskMirror trashes unmodified file");
}

console.log("\n--- Test 9: diskMirror remote delete preserves when CRDT unavailable ---");
{
	const events: CapturedTrace[] = [];

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/no-crdt-baseline.md";
	file.stat = { mtime: 1, size: 10 };
	const deleteEpisode = makeMarkdownDeleteEpisode(file.path);

	const app = {
		vault: {
			read: async () => "some local content",
			getAbstractFileByPath: (path: string) => (path === "Notes/no-crdt-baseline.md" ? file : null),
			delete: async () => { throw new Error("should not delete when CRDT unavailable"); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async () => { throw new Error("should not trash when CRDT unavailable"); },
		},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// Return null — no CRDT text available
		getTextForPath: () => null,
		isFileMetaDeleted: () => false,
		...deleteEpisode.vaultSyncFields,
	} as any;
	const editorBindings = {
		...CLOSED_PATH_EDITOR_AUTHORITY,
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await (mirror as any).handleRemoteDelete(
		"Notes/no-crdt-baseline.md",
		{ baselineText: null },
	);

	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	const deleted = findEvent(events, "disk", "remote-delete-applied");
	assert(!!preserved, "diskMirror preserves file when CRDT text is unavailable");
	assert(preserved?.details?.reason === "no-crdt-baseline-available", "trace includes no-crdt-baseline reason");
	assert(!deleted, "diskMirror does NOT delete when no CRDT baseline");
}

console.log("\n--- Test 10: diskMirror remote delete suppression fires before delete ---");
{
	const events: CapturedTrace[] = [];
	const trashedPaths: string[] = [];
	const suppressedPaths: string[] = [];

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/suppression-test.md";
	file.stat = { mtime: 1, size: 10 };

	const matchingContent = "same content";
	let filePresent = true;
	const deleteEpisode = makeMarkdownDeleteEpisode(file.path);
	const app = {
		vault: {
			read: async () => matchingContent,
			getAbstractFileByPath: (path: string) => (
				filePresent && path === "Notes/suppression-test.md" ? file : null
			),
			delete: async () => {},
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async (f: TFile & { path: string }) => {
				trashedPaths.push(f.path);
				filePresent = false;
			},
		},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		getTextForPath: () => ({ toString: () => matchingContent }),
		isFileMetaDeleted: () => false,
		...deleteEpisode.vaultSyncFields,
	} as any;
	const editorBindings = {
		...CLOSED_PATH_EDITOR_AUTHORITY,
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	// Intercept suppressDelete to verify it fires before delete
	const originalSuppressDelete = (mirror as any).suppressDelete.bind(mirror);
	(mirror as any).suppressDelete = (p: string) => {
		suppressedPaths.push(p);
		return originalSuppressDelete(p);
	};

	await (mirror as any).handleRemoteDelete(
		"Notes/suppression-test.md",
		{ baselineText: matchingContent },
	);

	assert(suppressedPaths.length === 1, "suppressDelete called once");
	assert(suppressedPaths[0] === "Notes/suppression-test.md", "suppressDelete called with correct path");
	assert(trashedPaths.length === 1, "file was trashed");
}

console.log("\n--- Test 11: diskMirror preserves when all recoverable trash mechanisms fail ---");
{
	const events: CapturedTrace[] = [];
	const deletedPaths: string[] = [];
	let vaultTrashCalls = 0;

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/trash-throws.md";
	file.stat = { mtime: 1, size: 10 };

	const matchingContent = "same content";
	const deleteEpisode = makeMarkdownDeleteEpisode(file.path);
	const app = {
		vault: {
			read: async () => matchingContent,
			getAbstractFileByPath: (path: string) => (path === "Notes/trash-throws.md" ? file : null),
			trash: async () => {
				vaultTrashCalls++;
				throw new Error("vault trash not supported");
			},
			delete: async (f: TFile & { path: string }) => { deletedPaths.push(f.path); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			// Trash throws — simulating adapter that doesn't support system trash
			trashFile: async () => { throw new Error("trash not supported"); },
		},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		getTextForPath: () => ({ toString: () => matchingContent }),
		isFileMetaDeleted: () => false,
		...deleteEpisode.vaultSyncFields,
	} as any;
	const editorBindings = {
		...CLOSED_PATH_EDITOR_AUTHORITY,
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, captureTrace(events));

	await (mirror as any).handleRemoteDelete(
		"Notes/trash-throws.md",
		{ baselineText: matchingContent },
	);

	const deleted = findEvent(events, "disk", "remote-delete-applied");
	const trashFailed = findEvent(events, "disk", "remote-delete-trash-failed");
	assert(!deleted, "delete is not reported as applied after recoverable trash failure");
	assert(!!trashFailed, "recoverable trash failure emits a trace");
	assert(vaultTrashCalls === 1, "vault.trash is attempted after trashFile fails");
	assert(deletedPaths.length === 0, "vault.delete is never used as an irreversible fallback");
	assert(
		mirror.preservedUnresolvedPaths.has("Notes/trash-throws.md"),
		"failed recoverable delete remains quarantined for user resolution",
	);
}

console.log("\n--- Test 12: known-dirty remote delete revives tombstone (no loop) ---");
{
	const events: CapturedTrace[] = [];
	let ensureFileCalled = false;
	let ensureFileArgs: { path: string; content: string; reviveTombstone: boolean } | null = null;

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/dirty-revive.md";
	file.stat = { mtime: 1, size: 20 };

	const diskContent = "locally edited version";
	const crdtContent = "old CRDT baseline";
	let activeContent = crdtContent;
	const activeText = { toString: () => activeContent, toJSON: () => activeContent };
	const deleteEpisode = makeMarkdownDeleteEpisode(file.path);
	const app = {
		vault: {
			read: async () => diskContent,
			getAbstractFileByPath: (path: string) => (path === "Notes/dirty-revive.md" ? file : null),
			delete: async () => { throw new Error("should not delete"); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async () => { throw new Error("should not trash"); },
		},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		getTextForPath: () => activeText,
		isFileMetaDeleted: () => false,
		ensureFile: (path: string, content: string, _device: string, opts: any) => {
			ensureFileCalled = true;
			ensureFileArgs = { path, content, reviveTombstone: opts?.reviveTombstone ?? false };
			activeContent = content;
			deleteEpisode.revive();
			return { kind: "created" as const, fileId: "active-file", ytext: activeText };
		},
		...deleteEpisode.vaultSyncFields,
	} as any;
	const editorBindings = {
		...CLOSED_PATH_EDITOR_AUTHORITY,
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(
		app, vaultSync, editorBindings, false, captureTrace(events),
		() => true, undefined, () => "TestDevice",
	);

	await (mirror as any).handleRemoteDelete(
		"Notes/dirty-revive.md",
		{ baselineText: crdtContent },
	);

	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	const revived = findEvent(events, "disk", "remote-delete-preserved-revived");
	assert(!!preserved, "known-dirty file is preserved");
	assert(preserved?.details?.reason === "local-file-modified-since-last-sync", "reason is known-dirty");
	assert(!!revived, "tombstone is revived for known-dirty file");
	assert(ensureFileCalled, "ensureFile was called to revive");
	assert(ensureFileArgs?.reviveTombstone === true, "reviveTombstone: true passed");
	assert(ensureFileArgs?.content === diskContent, "disk content used for revive");
}

console.log("\n--- Test 12b: remote delete preserves unsaved open editor content ---");
{
	const events: CapturedTrace[] = [];
	let ensureFileCalled = false;
	let ensureFileArgs: { path: string; content: string; reviveTombstone: boolean } | null = null;
	const trashedPaths: string[] = [];
	const deletedPaths: string[] = [];

	const path = "Notes/unsaved-open-editor.md";
	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = path;
	file.stat = { mtime: 1, size: 12 };

	const crdtContent = "old baseline";
	const diskContent = crdtContent;
	const editorContent = "typed but not autosaved yet";
	const editorAuthorityLease = { leaseId: "trace-unsaved-open-editor" };
	let activeContent = crdtContent;
	const activeText = { toString: () => activeContent, toJSON: () => activeContent };
	const deleteEpisode = makeMarkdownDeleteEpisode(path);
	const openView = Object.assign(new MarkdownView(), {
		file,
		editor: { getValue: () => editorContent },
	});

	const app = {
		vault: {
			read: async () => diskContent,
			getAbstractFileByPath: (p: string) => (p === path ? file : null),
			delete: async (f: TFile & { path: string }) => { deletedPaths.push(f.path); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => openView,
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view: openView });
			},
		},
		fileManager: {
			trashFile: async (f: TFile & { path: string }) => { trashedPaths.push(f.path); },
		},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		getTextForPath: () => activeText,
		isFileMetaDeleted: () => false,
		ensureFile: (p: string, content: string, _device: string, opts: any) => {
			ensureFileCalled = true;
			ensureFileArgs = { path: p, content, reviveTombstone: opts?.reviveTombstone ?? false };
			activeContent = content;
			deleteEpisode.revive();
			return { kind: "created" as const, fileId: "active-file", ytext: activeText };
		},
		...deleteEpisode.vaultSyncFields,
	} as any;
	const editorBindings = {
		capturePathEditorAuthority: (candidatePath: string) => candidatePath === path
			? {
				kind: "proven-single" as const,
				content: editorContent,
				lease: editorAuthorityLease,
			}
			: { kind: "none" as const },
		isPathEditorAuthorityLeaseCurrent: (lease: unknown) => lease === editorAuthorityLease,
		getLastEditorActivityForPath: () => Date.now(),
		isBound: () => true,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(
		app, vaultSync, editorBindings, false, captureTrace(events),
		() => true, undefined, () => "TestDevice",
	);

	await (mirror as any).handleRemoteDelete(path, { baselineText: crdtContent });

	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	const revived = findEvent(events, "disk", "remote-delete-preserved-revived");
	const deleted = findEvent(events, "disk", "remote-delete-applied");
	assert(!!preserved, "open editor content is preserved");
	assert(
		preserved?.details?.reason === "local-open-editor-modified-since-last-sync",
		"reason is open-editor-known-dirty",
	);
	assert(!!revived, "tombstone is revived for open editor dirty content");
	assert(!deleted, "remote delete is not applied while open editor has unsaved content");
	assert(trashedPaths.length === 0, "trashFile is not called for unsaved open editor");
	assert(deletedPaths.length === 0, "vault.delete is not called for unsaved open editor");
	assert(ensureFileCalled, "ensureFile is called to revive open editor content");
	assert(ensureFileArgs?.reviveTombstone === true, "open editor preserve uses reviveTombstone: true");
	assert(ensureFileArgs?.content === editorContent, "editor content is used for revive");
}

console.log("\n--- Test 13: unknown-baseline remote delete does NOT revive tombstone ---");
{
	const events: CapturedTrace[] = [];
	let ensureFileCalled = false;

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/unknown-baseline.md";
	file.stat = { mtime: 1, size: 10 };
	const deleteEpisode = makeMarkdownDeleteEpisode(file.path);

	const app = {
		vault: {
			read: async () => "some content on disk",
			getAbstractFileByPath: (path: string) => (path === "Notes/unknown-baseline.md" ? file : null),
			delete: async () => { throw new Error("should not delete"); },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async () => { throw new Error("should not trash"); },
		},
	} as any;
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// CRDT unavailable — unknown baseline
		getTextForPath: () => null,
		isFileMetaDeleted: () => false,
		ensureFile: () => {
			ensureFileCalled = true;
			return {};
		},
		...deleteEpisode.vaultSyncFields,
	} as any;
	const editorBindings = {
		...CLOSED_PATH_EDITOR_AUTHORITY,
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(
		app, vaultSync, editorBindings, false, captureTrace(events),
		() => true, undefined, () => "TestDevice",
	);

	await (mirror as any).handleRemoteDelete(
		"Notes/unknown-baseline.md",
		{ baselineText: null },
	);

	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	const revived = findEvent(events, "disk", "remote-delete-preserved-revived");
	const deleted = findEvent(events, "disk", "remote-delete-applied");
	assert(!!preserved, "unknown-baseline file is preserved");
	assert(preserved?.details?.reason === "no-crdt-baseline-available", "reason is no-baseline");
	assert(!revived, "tombstone is NOT revived for unknown-baseline");
	assert(!deleted, "file is NOT deleted");
	assert(!ensureFileCalled, "ensureFile is NOT called — no auto-resurrection");
}

console.log("\n--- Test 5: Multi-pass: unknown-baseline preserved file is NOT revived by importUntrackedFiles ---");
{
	// This is the critical system-level test demanded by all three reviewers.
	// Scenario:
	// 1. Local file exists.
	// 2. Remote tombstone arrives with no CRDT baseline.
	// 3. Handler preserves file as unresolved (does NOT revive).
	// 4. importUntrackedFiles() runs on next reconciliation pass.
	// 5. Assert: file is NOT revived, tombstone remains, ensureFile NOT called.

	const { ReconciliationController } = await import("../src/runtime/reconciliationController");
	const events: CapturedTrace[] = [];
	let ensureFileCalled = false;

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/unknown-baseline.md";
	(file as any).stat = { mtime: 1, size: 10 };
	const deleteEpisode = makeMarkdownDeleteEpisode(file.path);
	const revivedText = { toString: () => "some content on disk" };

	// --- Step 1: Set up DiskMirror and trigger preserve-unresolved ---
	const app = {
		vault: {
			read: async () => "some content on disk",
			getAbstractFileByPath: (path: string) => (path === "Notes/unknown-baseline.md" ? file : null),
			delete: async () => { throw new Error("should not delete"); },
			adapter: { stat: async () => ({ mtime: 1, size: 10 }) },
		},
		workspace: {
			getActiveViewOfType: () => null,
			iterateAllLeaves: () => {},
		},
		fileManager: {
			trashFile: async () => { throw new Error("should not trash"); },
		},
	} as any;

	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// CRDT unavailable — unknown baseline
		getTextForPath: () => deleteEpisode.isTombstoned() ? null : revivedText,
		isFileMetaDeleted: () => false,
		isInitialized: true,
		markInitialized: () => {},
		ensureFile: () => {
			ensureFileCalled = true;
			deleteEpisode.revive();
			return { kind: "created" as const, fileId: "active-file", ytext: revivedText };
		},
		getActiveMarkdownPaths: () => [],
		...deleteEpisode.vaultSyncFields,
	} as any;

	const editorBindings = {
		...CLOSED_PATH_EDITOR_AUTHORITY,
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;

	const mirror = new DiskMirror(
		app, vaultSync, editorBindings, false, captureTrace(events),
		() => true, undefined, () => "TestDevice",
	);

	// Step 2: Remote tombstone arrives — no CRDT baseline
	await (mirror as any).handleRemoteDelete(
		"Notes/unknown-baseline.md",
		{ baselineText: null },
	);

	// Verify: path is now in preserved-unresolved set
	assert(
		mirror.preservedUnresolvedPaths.has("Notes/unknown-baseline.md"),
		"path recorded in preservedUnresolvedPaths after remote-delete with unknown baseline",
	);
	assert(!ensureFileCalled, "ensureFile NOT called during initial remote-delete");

	// --- Step 3: Set up ReconciliationController and run importUntrackedFiles ---
	const controller = new ReconciliationController({
		app,
		getSettings: () => ({ deviceName: "TestDevice" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync,
		getDiskMirror: () => mirror,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings,
		getDiskIndex: () => ({}),
		setDiskIndex: () => {},
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: captureTrace(events),
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	// Inject the preserved file as "untracked" — simulates reconciliation
	// discovering the file on disk with no CRDT entry
	(controller as any).untrackedFiles = ["Notes/unknown-baseline.md"];

	// Step 4: Run importUntrackedFiles — the next reconciliation pass
	await (controller as any).importUntrackedFiles();

	// Step 5: Assert no resurrection
	assert(!ensureFileCalled, "ensureFile NOT called by importUntrackedFiles (preserved-unresolved guard)");
	assert(
		mirror.preservedUnresolvedPaths.has("Notes/unknown-baseline.md"),
		"path remains in preservedUnresolvedPaths (not auto-cleared)",
	);
	const skipTrace = events.find(
		(e) => e.source === "reconcile" && e.msg === "import-untracked-skipped-preserved-unresolved",
	);
	assert(!!skipTrace, "trace emitted for skipped preserved-unresolved import");

	// Step 6: Simulate user explicitly modifying the file → clears the guard
	mirror.clearPreservedUnresolved("Notes/unknown-baseline.md");
	assert(
		!mirror.preservedUnresolvedPaths.has("Notes/unknown-baseline.md"),
		"path cleared from preservedUnresolvedPaths after user action",
	);

	// Now importUntrackedFiles WOULD call ensureFile (proving the guard was the only blocker)
	(controller as any).untrackedFiles = ["Notes/unknown-baseline.md"];
	await (controller as any).importUntrackedFiles();
	assert(ensureFileCalled, "ensureFile IS called after preserved-unresolved guard is cleared");
}

console.log("\n--- Test 6: Multi-pass: read-failure during remote-delete becomes preserve-unresolved (not apply-delete) ---");
{
	const events: CapturedTrace[] = [];
	let fileTrashed = false;
	let fileDeleted = false;

	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = "Notes/read-fails.md";
	file.stat = { mtime: 1, size: 10 };
	const baselineContent = "known baseline content";
	const deleteEpisode = makeMarkdownDeleteEpisode(file.path);

	const app = {
		vault: {
			// Read throws — simulates locked/busy file
			read: async () => { throw new Error("EBUSY: file is locked"); },
			getAbstractFileByPath: (path: string) => (path === "Notes/read-fails.md" ? file : null),
			delete: async () => { fileDeleted = true; },
			adapter: {},
		},
		workspace: {
			getActiveViewOfType: () => null,
		},
		fileManager: {
			trashFile: async () => { fileTrashed = true; },
		},
	} as any;

	const ytext = { toString: () => baselineContent };
	const vaultSync = {
		provider: {},
		meta: { observe() {}, unobserve() {} },
		ydoc: { on() {}, off() {} },
		getFileIdForText: () => null,
		idToText: new Map(),
		// CRDT HAS a baseline — but read will fail
		getTextForPath: () => ytext,
		isFileMetaDeleted: () => false,
		ensureFile: () => null,
		...deleteEpisode.vaultSyncFields,
	} as any;
	const editorBindings = {
		...CLOSED_PATH_EDITOR_AUTHORITY,
		getLastEditorActivityForPath: () => null,
		isBound: () => false,
		unbindByPath: () => {},
	} as any;
	const mirror = new DiskMirror(
		app, vaultSync, editorBindings, false, captureTrace(events),
		() => true, undefined, () => "TestDevice",
	);

	await (mirror as any).handleRemoteDelete(
		"Notes/read-fails.md",
		{ baselineText: baselineContent },
	);

	// File should NOT be deleted or trashed
	assert(!fileDeleted, "file NOT deleted when read fails");
	assert(!fileTrashed, "file NOT trashed when read fails");

	// Should be preserved-unresolved
	const preserved = findEvent(events, "disk", "remote-delete-conflict-preserved");
	assert(!!preserved, "preserve trace emitted");
	assert(preserved?.details?.reason === "read-failed-cannot-verify", "reason is read-failed");

	// Path should be in preserved-unresolved set
	assert(
		mirror.preservedUnresolvedPaths.has("Notes/read-fails.md"),
		"path recorded as preserved-unresolved after read failure",
	);
}

interface OpenExternalTraceFixtureOptions {
	path: string;
	baseline: string;
	live: string;
	external: string;
	blockFrontmatter?: boolean;
	recentTyping?: boolean;
}

interface OpenExternalTraceFixture {
	events: CapturedTrace[];
	controller: ReconciliationController;
	doc: Y.Doc;
	captureCandidate(sequence: number): void;
	ingest(): Promise<void>;
	setBaselineReadHook(hook: (() => Promise<void>) | null): void;
	advanceEditorRevision(): void;
	dispose(): void;
}

function traceContentHash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function makeOpenExternalTraceFile(path: string, size: number): TFile {
	const file = new TFile() as TFile & {
		path: string;
		stat: { mtime: number; size: number };
	};
	file.path = path;
	file.stat = { ctime: 1, mtime: 1, size };
	return file;
}

function clearOpenExternalTraceDrainTimer(controller: ReconciliationController): void {
	const internals = controller as never as {
		markdownDrainTimer: ReturnType<typeof setTimeout> | null;
	};
	if (internals.markdownDrainTimer) {
		clearTimeout(internals.markdownDrainTimer);
		internals.markdownDrainTimer = null;
	}
}

function buildOpenExternalTraceFixture(
	options: OpenExternalTraceFixtureOptions,
): OpenExternalTraceFixture {
	const { path } = options;
	let diskContent = options.external;
	let editorContent = options.live;
	let editorRevision = 0;
	let baselineReadHook: (() => Promise<void>) | null = null;
	let diskIngestPort: DiskIngestPort | null = null;
	const events: CapturedTrace[] = [];
	const artifacts = new Map<string, { file: TFile; content: string }>();
	const baselineTexts = new Map([[traceContentHash(options.baseline), options.baseline]]);
	let diskIndex: Record<string, { mtime: number; size: number; contentHash?: string }> = {
		[path]: {
			mtime: 0,
			size: options.baseline.length,
			contentHash: traceContentHash(options.baseline),
		},
	};
	const lastEditorActivity = options.recentTyping ? Date.now() : null;

	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, options.live);
	doc.on("afterTransaction", (transaction) => {
		if (transaction.origin !== ORIGIN_OPEN_EXTERNAL_EDIT_MERGE) return;
		// Model the bound CodeMirror view receiving the controller-origin Y.Text
		// patch before the post-merge ticket/marker is recaptured.
		editorContent = ytext.toString();
		editorRevision += 1;
	});
	const file = makeOpenExternalTraceFile(path, diskContent.length);
	const view = new MarkdownView(null as never) as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent } as never;
	let editorAuthorityLeaseSequence = 0;
	const editorAuthorityLeases = new Map<
		object,
		{ editorRevision: number; editorContent: string }
	>();

	const editorBindings = {
		capturePathEditorAuthority: (candidatePath: string) => {
			if (candidatePath !== path) return { kind: "none" as const };
			const lease = { leaseId: `trace-open-external-${++editorAuthorityLeaseSequence}` };
			editorAuthorityLeases.set(lease, { editorRevision, editorContent });
			return {
				kind: "proven-single" as const,
				content: editorContent,
				lease,
			};
		},
		isPathEditorAuthorityLeaseCurrent: (lease: object) => {
			const captured = editorAuthorityLeases.get(lease);
			return captured?.editorRevision === editorRevision
				&& captured.editorContent === editorContent;
		},
		isBound: (candidatePath: string) => candidatePath === path,
		getBindingDebugInfoForView: () => ({
			leafId: "trace-leaf",
			storedCmId: "trace-cm",
			liveCmId: "trace-cm",
			cmMatches: true,
		}),
		getCollabDebugInfoForView: () => ({
			hasSyncFacet: true,
			awarenessMatchesProvider: true,
			yTextMatchesExpected: true,
			undoManagerMatchesFacet: true,
			facetFileId: "trace-file-id",
			expectedFileId: "trace-file-id",
		}),
		getLastEditorActivityForPath: () => lastEditorActivity,
		captureOpenEditorMutationTicket: (
			ticketPath: string,
			ticketViews: readonly MarkdownView[],
		) => ({
			path: ticketPath,
			views: ticketViews.map((ticketView) => ({
				view: ticketView,
				viewId: "trace-view",
				leafId: "trace-leaf",
				cm: null,
				cmId: null,
				bindingEpoch: 0,
				editorRevision,
				editorAuthorityRevision: editorRevision,
				editorAuthorityContent: editorContent,
				editorDocument: editorRevision,
				editorContent,
			})),
		}),
		validateOpenEditorMutationTicket: (ticket: {
			path: string;
			views: ReadonlyArray<{
				view: MarkdownView;
				leafId: string;
				editorRevision: number;
			}>;
		}, currentViews: readonly MarkdownView[]) => {
			if (
				ticket.path !== path ||
				ticket.views.length !== currentViews.length ||
				ticket.views.some((snapshot, index) => snapshot.view !== currentViews[index])
			) {
				return { current: false as const, reason: "view-set-changed" as const };
			}
			const stale = ticket.views.find((snapshot) =>
				snapshot.editorRevision !== editorRevision
			);
			return stale
				? {
					current: false as const,
					reason: "editor-revision-changed" as const,
					leafId: stale.leafId,
				}
				: { current: true as const };
		},
		separateUndoCaptureForPath: () => 1,
		repair: () => true,
		rebind: () => {},
		unbindByPath: () => {},
	};

	const app = {
		vault: {
			read: async (candidate: TFile) => {
				if (candidate.path === path) return diskContent;
				const artifact = artifacts.get(candidate.path);
				if (artifact) return artifact.content;
				throw new Error("trace fixture unexpected file read");
			},
			create: async (artifactPath: string, content: string) => {
				const artifactFile = makeOpenExternalTraceFile(artifactPath, content.length);
				artifacts.set(artifactPath, { file: artifactFile, content });
				return artifactFile;
			},
			adapter: {
				stat: async () => ({ mtime: 1, size: diskContent.length }),
			},
			getAbstractFileByPath: (candidatePath: string) => (
				candidatePath === path
					? file
					: (artifacts.get(candidatePath)?.file ?? null)
			),
			getMarkdownFiles: () => [
				file,
				...Array.from(artifacts.values(), (artifact) => artifact.file),
			],
		},
		workspace: {
			iterateAllLeaves: (callback: (leaf: { view: MarkdownView }) => void) => {
				callback({ view });
			},
		},
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getTextForPath: (candidatePath: string) => candidatePath === path ? ytext : null,
		getActiveMarkdownPaths: () => [path],
		isPendingRenameTarget: () => false,
		isMarkdownTombstoned: () => false,
		getFileIdForText: () => "trace-file-id",
		serverAckTracker: {
			withActiveOpId: (_opId: string | undefined, run: () => void) => run(),
		},
	};

	const controller = new ReconciliationController({
		app: app as never,
		getSettings: () => ({ deviceName: "TraceTest" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as never,
		getVaultSync: () => vaultSync as never,
		getDiskMirror: () => ({
			shouldSuppressCreate: async () => false,
			shouldSuppressModify: async () => false,
			suppressLocalCreate: async () => {},
			isPreservedUnresolved: () => false,
			getPreservedUnresolvedEntries: () => [],
			recordPreservedUnresolved: () => {},
			clearPreservedUnresolved: () => {},
			flushWrite: async (
				flushPath: string,
				_force: boolean,
				writeOptions: { expectedDiskContent?: string; recordBaseline?: boolean } = {},
			) => {
				if (
					writeOptions.expectedDiskContent !== undefined &&
					writeOptions.expectedDiskContent !== diskContent
				) {
					return {
						kind: "deferred" as const,
						path: flushPath,
						reason: "disk-changed-during-write" as const,
					};
				}
				const settledContent = ytext.toString();
				diskContent = settledContent;
				return {
					kind: "written" as const,
					path: flushPath,
					isCreate: false,
					content: settledContent,
					contentHash: traceContentHash(settledContent),
					baselineRecorded: writeOptions.recordBaseline !== false,
				};
			},
		}) as never,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as never,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
		getBaselineText: async (hash: string) => {
			await baselineReadHook?.();
			return baselineTexts.get(hash) ?? null;
		},
		recordBaselineText: (hash: string, content: string) => {
			baselineTexts.set(hash, content);
		},
		recordConflictMergeBase: () => {},
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: (
			_candidatePath: string,
			_previousContent: string | null,
			_nextContent: string,
			reason: string,
		) => options.blockFrontmatter === true &&
			reason === "bound-file-open-safe-external-merge",
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: captureTrace(events),
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		registerDiskIngestPort: (port: DiskIngestPort) => { diskIngestPort = port; },
	});

	return {
		events,
		controller,
		doc,
		captureCandidate: (sequence) => {
			const candidate: InterceptedExternalDiskMutation = Object.freeze({
				path,
				content: options.external,
				sequence,
				observedAt: sequence,
				ctime: sequence,
				mtime: sequence,
				size: options.external.length,
			});
			controller.noteInterceptedExternalDiskMutation(candidate);
			clearOpenExternalTraceDrainTimer(controller);
		},
		ingest: () => {
			if (!diskIngestPort) throw new Error("trace fixture disk ingest port missing");
			return diskIngestPort.ingestDiskFileNow(path, "modify");
		},
		setBaselineReadHook: (hook) => { baselineReadHook = hook; },
		advanceEditorRevision: () => { editorRevision += 1; },
		dispose: () => {
			clearOpenExternalTraceDrainTimer(controller);
			controller.reset();
			doc.destroy();
		},
	};
}

console.log("\n--- Test 14: open external edit traces are complete and privacy-safe ---");
{
	const expectedMessages = [
		"open-external-candidate-captured",
		"open-external-recent-typing-deferred",
		"open-external-clean-merge-applied",
		"open-external-overlapping-hunk-preserved",
		"open-external-stale-replan",
		"open-external-frontmatter-blocked",
		"open-external-disk-settled",
		"open-external-baseline-advanced",
	] as const;
	type ExpectedOpenExternalMessage = typeof expectedMessages[number];

	const baselineMarker = "TRACE_BASELINE_CONTENT_SENTINEL";
	const liveMarker = "TRACE_LIVE_CONTENT_SENTINEL";
	const externalMarker = "TRACE_EXTERNAL_CONTENT_SENTINEL";
	const arbitraryThrownMessage = "TRACE_ARBITRARY_THROWN_MESSAGE_SENTINEL";
	const baselineContent = `## Work\n${baselineMarker}\n\n## Life\nshared life\n`;
	const liveContent = `## Work\n${liveMarker}\n\n## Life\nshared life\n`;
	const externalContent = `## Work\n${baselineMarker}\n\n## Life\n${externalMarker}\n`;
	const mergedContent = `## Work\n${liveMarker}\n\n## Life\n${externalMarker}\n`;
	const overlappingExternalContent =
		`## Work\n${externalMarker}\n\n## Life\nshared life\n`;
	const privateValues = [
		baselineMarker,
		liveMarker,
		externalMarker,
		baselineContent,
		liveContent,
		externalContent,
		mergedContent,
		overlappingExternalContent,
		arbitraryThrownMessage,
	];

	const clean = buildOpenExternalTraceFixture({
		path: "Notes/trace-clean.md",
		baseline: baselineContent,
		live: liveContent,
		external: externalContent,
	});
	clean.captureCandidate(101);
	await clean.ingest();

	const conflict = buildOpenExternalTraceFixture({
		path: "Notes/trace-overlap.md",
		baseline: baselineContent,
		live: liveContent,
		external: overlappingExternalContent,
	});
	await conflict.ingest();

	const guarded = buildOpenExternalTraceFixture({
		path: "Notes/trace-frontmatter.md",
		baseline: baselineContent,
		live: liveContent,
		external: externalContent,
		blockFrontmatter: true,
	});
	await guarded.ingest();

	const stale = buildOpenExternalTraceFixture({
		path: "Notes/trace-stale.md",
		baseline: baselineContent,
		live: liveContent,
		external: externalContent,
	});
	let markBaselineReadStarted: (() => void) | null = null;
	let releaseBaselineRead: (() => void) | null = null;
	const baselineReadStarted = new Promise<void>((resolve) => {
		markBaselineReadStarted = resolve;
	});
	const baselineReadGate = new Promise<void>((resolve) => {
		releaseBaselineRead = resolve;
	});
	stale.setBaselineReadHook(async () => {
		markBaselineReadStarted?.();
		markBaselineReadStarted = null;
		await baselineReadGate;
	});
	const staleIngest = stale.ingest();
	await baselineReadStarted;
	stale.advanceEditorRevision();
	releaseBaselineRead?.();
	await staleIngest;
	stale.setBaselineReadHook(null);

	const typing = buildOpenExternalTraceFixture({
		path: "Notes/trace-recent-typing.md",
		baseline: baselineContent,
		live: liveContent,
		external: externalContent,
		recentTyping: true,
	});
	await typing.ingest();

	const scenarioEvents = {
		clean: clean.events,
		conflict: conflict.events,
		guarded: guarded.events,
		stale: stale.events,
		typing: typing.events,
	};
	assert(
		scenarioEvents.clean.some((event) => event.msg === "open-external-candidate-captured"),
		"clean intercepted scenario emits candidate-captured",
	);
	assert(
		scenarioEvents.clean.some((event) => event.msg === "open-external-clean-merge-applied"),
		"clean three-way scenario emits clean-merge-applied",
	);
	assert(
		scenarioEvents.clean.some((event) => event.msg === "open-external-disk-settled"),
		"clean three-way scenario emits disk-settled",
	);
	assert(
		scenarioEvents.clean.some((event) => event.msg === "open-external-baseline-advanced"),
		"clean three-way scenario emits baseline-advanced",
	);
	assert(
		scenarioEvents.conflict.some((event) =>
			event.msg === "open-external-overlapping-hunk-preserved"
		),
		"overlapping-hunk scenario emits preserved trace",
	);
	assert(
		scenarioEvents.guarded.some((event) => event.msg === "open-external-frontmatter-blocked"),
		"frontmatter-guarded scenario emits blocked trace",
	);
	assert(
		scenarioEvents.stale.some((event) => event.msg === "open-external-stale-replan"),
		"real editor-revision race emits stale-replan",
	);
	assert(
		scenarioEvents.typing.some((event) => event.msg === "open-external-recent-typing-deferred"),
		"recent editor activity scenario emits typing-deferred",
	);

	const expectedMessageSet = new Set<string>(expectedMessages);
	const openExternalEvents = Object.values(scenarioEvents)
		.flat()
		.filter((event): event is CapturedTrace & { msg: ExpectedOpenExternalMessage } =>
			expectedMessageSet.has(event.msg)
		);
	const contracts: Record<ExpectedOpenExternalMessage, {
		keys: readonly string[];
		reasons: readonly string[];
	}> = {
		"open-external-candidate-captured": {
			keys: ["path", "reason", "sequence", "contentLength"],
			reasons: ["intercepted-external-disk-mutation"],
		},
		"open-external-recent-typing-deferred": {
			keys: ["path", "reason", "diskLength", "currentLength", "deferMs"],
			reasons: ["recent-editor-activity", "recent-editor-activity-local-only"],
		},
		"open-external-clean-merge-applied": {
			keys: ["path", "reason", "diskLength", "currentLength", "targetLength"],
			reasons: ["apply-external", "apply-clean-merge"],
		},
		"open-external-overlapping-hunk-preserved": {
			keys: [
				"path",
				"reason",
				"diskLength",
				"currentLength",
				"hunkCount",
				"artifactCreated",
			],
			reasons: ["overlapping-hunks"],
		},
		"open-external-stale-replan": {
			keys: ["reason", "deferMs"],
			reasons: ["open-external-clean-merge", "open-external-conflict-settlement"],
		},
		"open-external-frontmatter-blocked": {
			keys: ["path", "reason", "diskLength", "currentLength", "targetLength"],
			reasons: ["bound-file-open-safe-external-merge"],
		},
		"open-external-disk-settled": {
			keys: ["path", "reason", "contentLength", "contentHashPrefix"],
			reasons: [
				"apply-external",
				"apply-clean-merge",
				"already-settled",
				"open-external-representation-normalized",
				"open-external-current-only",
				"open-external-overlapping-hunks",
				"open-external-missing-baseline",
			],
		},
		"open-external-baseline-advanced": {
			keys: ["path", "reason", "contentLength", "contentHashPrefix"],
			reasons: [
				"apply-external",
				"apply-clean-merge",
				"already-settled",
				"open-external-representation-normalized",
				"open-external-current-only",
				"open-external-overlapping-hunks",
				"open-external-missing-baseline",
			],
		},
	};
	const boundedCategories = ["exception", "non-error-throw"];
	for (const msg of expectedMessages) {
		const emitted = openExternalEvents.filter((event) => event.msg === msg);
		assert(
			emitted.length > 0,
			`${msg} is emitted by real controller behavior`,
		);
		for (const event of emitted) {
			const details = (event.details ?? {}) as Record<string, unknown>;
			const contract = contracts[msg];
			const unexpectedKeys = Object.keys(details).filter((key) =>
				!contract.keys.includes(key)
			);
			assert(
				unexpectedKeys.length === 0,
				`${msg} details use only the explicit key allowlist`,
			);
			assert(
				contract.keys.every((key) => key in details),
				`${msg} details include every contracted key`,
			);
			assert(
				typeof details.reason === "string" && contract.reasons.includes(details.reason),
				`${msg} reason is bounded`,
			);
			for (const categoryKey of ["category", "errorCategory"] as const) {
				if (categoryKey in details) {
					assert(
						typeof details[categoryKey] === "string" &&
							boundedCategories.includes(details[categoryKey]),
						`${msg} ${categoryKey} is bounded`,
					);
				}
			}
			const serialized = JSON.stringify(details);
			assert(
				privateValues.every((privateValue) => !serialized.includes(privateValue)),
				`${msg} excludes baseline/live/external/merged content and arbitrary thrown messages`,
			);
		}
	}

	clean.dispose();
	conflict.dispose();
	guarded.dispose();
	stale.dispose();
	typing.dispose();
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
