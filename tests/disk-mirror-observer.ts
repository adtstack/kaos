/**
 * FU-14 — DiskMirror observer wiring test (Phase 1.6b).
 *
 * Phase 1.6 proved the recovery amplifier class is guarded at the Yjs/origin
 * layer using a simulated decision function. This test drives the actual
 * DiskMirror text observer and afterTransaction handler to prove the WIRING:
 *
 *   recovery-origin transaction → observer fires → isLocalOrigin gate → SKIP
 *   provider-origin transaction  → observer fires → isLocalOrigin gate → scheduleWrite
 *
 * Two observer paths are tested:
 *
 *   A. afterTransaction handler — fires for every transaction on the Y.Doc.
 *      Handles CLOSED files: not open in Obsidian, no per-file text observer.
 *      Gate: `if (isLocalOrigin(txn.origin, provider)) return;`
 *
 *   B. Per-file text observer — attached via observeText() when a file is opened.
 *      Gate: `if (isLocalOrigin(txn.origin, provider)) return;`
 *
 * Both paths gate on the same predicate. This test proves neither path schedules
 * a write for recovery origins, and both paths do schedule for provider origin.
 *
 * SCOPE — what this test does NOT cover (FU-14 still partially open):
 *   - ReconciliationController choosing disk as the only authority
 *   - EditorBinding repair() vs heal() path selection
 *   - flushWriteUnlocked() actual disk I/O
 *   - Suppression fingerprint behavior
 *   - Debounce timer drain and write queue flush
 *
 * Obsidian dependency: this test uses JITI_ALIAS to redirect "obsidian" to
 * tests/mocks/obsidian.ts. The mock provides normalizePath (identity) and
 * stub classes for MarkdownView/TFile. Tests run under node --import jiti/register.
 */

import * as Y from "yjs";
import { MarkdownView, TFile } from "obsidian";
import {
	DiskMirror,
	type RemoteProjectionAdmissionLease,
} from "../src/sync/diskMirror";
import { RemoteProjectionPolicyGate } from "../src/runtime/remoteProjectionPolicyGate";
import { contentBaselineHash } from "../src/sync/diskIndex";
import type { MetaChangeBatch } from "../src/sync/fileMeta";
import type { EnsureFileResult } from "../src/sync/vaultSync";
import type {
	EditorAuthorityLease,
	PathEditorAuthority,
} from "../src/sync/pathEditorAuthority";
import {
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
	ORIGIN_EDITOR_AUTHORITY_SHIELD,
	ORIGIN_EDITOR_EXTERNAL_RELOAD_REJECT,
	ORIGIN_EDITOR_HEALTH_HEAL,
	ORIGIN_RESTORE,
	ORIGIN_SEED,
} from "../src/sync/origins";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

// ── Harness ───────────────────────────────────────────────────────────────────

const FILE_PATH = "notes/test.md";
const FILE_ID = "file-001";

function makeHarness(options: {
	filePath?: string;
	opaqueOpenFileView?: boolean;
	openEditorContent?: string | (() => string);
	initialDiskContent?: string;
	onRead?: () => void | Promise<void>;
	onGetAbstractFile?: (path: string, file: TFile | null, callCount: number) => void;
	onBeforeProcess?: () => void | Promise<void>;
	onAfterProcess?: () => void | Promise<void>;
	onBeforeCreate?: () => void | Promise<void>;
	onAfterCreate?: () => void | Promise<void>;
	onBeforeRename?: () => void | Promise<void>;
	onAfterRename?: () => void | Promise<void>;
	onBeforeTrash?: () => void | Promise<void>;
	onAfterTrash?: () => void | Promise<void>;
	stripBomOnVaultRead?: boolean;
	trashBehavior?: "success" | "throw" | "missing";
	ensureFileBehavior?: "settle" | "throw" | "replan" | "blocked" | "mismatch";
	onAfterEnsureFileSettle?: () => void;
	supportsAtomicProcess?: boolean;
	baselineHashProvider?: (path: string) => string | null | undefined;
	baselineTextProvider?: (path: string) => Promise<string | null> | string | null;
	isMarkdownPathSyncable?: (path: string) => boolean;
	isRemoteProjectionAllowed?: (path: string) => boolean;
	editorAuthorityKind?:
		| "auto"
		| "none"
		| "transitioning"
		| "multiple"
		| "read-failed"
		| "unmanaged-view";
	captureRemoteProjectionAdmission?: (
		paths: readonly string[],
	) => RemoteProjectionAdmissionLease | null;
} = {}) {
	const filePath = options.filePath ?? FILE_PATH;
	const doc = new Y.Doc();
	const meta = doc.getMap<{ path: string; deleted?: boolean }>("meta");
	const ytext = doc.getText("content");
	const fakeProvider = { __kind: "fake-provider" };
	const diskFiles = new Map<string, string>();
	let metaChangeObserver: ((batch: MetaChangeBatch) => void) | null = null;
	let authoritativeDeleteFingerprint: string | null = null;
	const deleteCalls: string[] = [];
	let trashAttempts = 0;
	let hardDeleteCalls = 0;
	let ensureFileCalls = 0;
	let processCalls = 0;
	let modifyCalls = 0;
	let renameCalls = 0;
	let abstractFileLookups = 0;
	if (options.initialDiskContent !== undefined) {
		diskFiles.set(filePath, options.initialDiskContent);
	}

	// Seed meta so afterTxnHandler can resolve fileId → path
	doc.transact(() => {
		meta.set(FILE_ID, { path: filePath, deleted: false });
	});

	const fakeVaultSync = {
		provider: fakeProvider,
		ydoc: doc,
		meta,
		getTextForPath: (path: string) => (
			authoritativeDeleteFingerprint === null && meta.get(FILE_ID)?.path === path
				? ytext
				: null
		),
		getFileIdForText: (text: Y.Text) => (text === ytext ? FILE_ID : null),
		idToText: new Map([[FILE_ID, ytext]]),
		isFileMetaDeleted: (m: { deleted?: boolean } | undefined) => Boolean(m?.deleted),
		getAuthoritativeMarkdownDeleteSnapshot: () => authoritativeDeleteFingerprint === null
			? null
			: { fingerprint: authoritativeDeleteFingerprint },
		getActiveFileIdsForPath: () => authoritativeDeleteFingerprint === null ? [FILE_ID] : [],
		isPathTombstoned: () => authoritativeDeleteFingerprint !== null,
		ensureFile: (path: string, content: string): EnsureFileResult => {
			ensureFileCalls++;
			if (options.ensureFileBehavior === "throw") {
				throw new Error("deterministic ensureFile failure");
			}
			if (options.ensureFileBehavior === "blocked") {
				return { kind: "blocked", reason: "tombstone" };
			}
			if (options.ensureFileBehavior === "replan") {
				return { kind: "replan", reason: "active-set-changed" };
			}
			doc.transact(() => {
				ytext.delete(0, ytext.length);
				ytext.insert(
					0,
					options.ensureFileBehavior === "mismatch" ? `${content}MISMATCH` : content,
				);
			});
			authoritativeDeleteFingerprint = null;
			options.onAfterEnsureFileSettle?.();
			return { kind: "created", fileId: FILE_ID, ytext };
		},
		// v3: semantic change subscription used by DiskMirror.startMapObservers().
		observeMetaChanges: (cb: (batch: MetaChangeBatch) => void) => {
			metaChangeObserver = cb;
			return () => {
				if (metaChangeObserver === cb) metaChangeObserver = null;
			};
		},
	};

	const markdownView = options.openEditorContent === undefined
		? null
		: Object.assign(new MarkdownView(), {
			file: { path: filePath },
			editor: {
				getValue: () => {
					const value = options.openEditorContent;
					return typeof value === "function" ? value() : value ?? "";
				},
			},
		});
	const workspaceView = options.opaqueOpenFileView
		? { file: { path: filePath } }
		: markdownView;
	let editorAuthorityEpoch = 0;
	let editorAuthorityLeaseSequence = 0;
	const editorAuthorityLeases = new Map<
		string,
		{ epoch: number; content: string }
	>();
	const readConfiguredEditorAuthority = (): PathEditorAuthority | { kind: "content"; content: string } => {
		const configured = options.editorAuthorityKind ?? "auto";
		if (configured === "none") return { kind: "none" };
		if (configured !== "auto") return { kind: "blocked", reason: configured };
		if (options.opaqueOpenFileView) {
			return { kind: "blocked", reason: "unmanaged-view" };
		}
		if (options.openEditorContent === undefined) return { kind: "none" };
		const value = options.openEditorContent;
		return {
			kind: "content",
			content: typeof value === "function" ? value() : value,
		};
	};
	const fakeEditorBindings = {
		getLastEditorActivityForPath: () => null,
		unbindByPath: () => {},
		updatePathsAfterRename: () => {},
		capturePathEditorAuthority: (_path: string): PathEditorAuthority => {
			const current = readConfiguredEditorAuthority();
			if (current.kind !== "content") return current;
			const leaseId = `test-editor-authority-${++editorAuthorityLeaseSequence}`;
			const lease = { leaseId } as EditorAuthorityLease;
			editorAuthorityLeases.set(leaseId, {
				epoch: editorAuthorityEpoch,
				content: current.content,
			});
			return { kind: "proven-single", content: current.content, lease };
		},
		isPathEditorAuthorityLeaseCurrent: (lease: EditorAuthorityLease): boolean => {
			const captured = editorAuthorityLeases.get(lease.leaseId);
			if (!captured || captured.epoch !== editorAuthorityEpoch) return false;
			const current = readConfiguredEditorAuthority();
			return current.kind === "content" && current.content === captured.content;
		},
	};
	const byteLength = (content: string): number => new TextEncoder().encode(content).byteLength;
	const makeDiskFileIdentity = (path: string, contentLength: number) => Object.assign(new TFile(), {
		path,
		stat: { ctime: 1, mtime: 1, size: contentLength },
	});
	const diskFileIdentities = new Map<string, TFile>();
	const nonFilePathOccupants = new Map<string, { path: string }>();
	let currentDiskFile = makeDiskFileIdentity(
		filePath,
		options.initialDiskContent === undefined ? 0 : byteLength(options.initialDiskContent),
	);
	if (options.initialDiskContent !== undefined) diskFileIdentities.set(filePath, currentDiskFile);
	const getDiskFileIdentity = (path: string): TFile | null => {
		const nonFile = nonFilePathOccupants.get(path);
		if (nonFile) return nonFile as unknown as TFile;
		if (!diskFiles.has(path)) {
			diskFileIdentities.delete(path);
			return null;
		}
		let file = diskFileIdentities.get(path);
		if (!file) {
			file = makeDiskFileIdentity(path, byteLength(diskFiles.get(path) ?? ""));
			diskFileIdentities.set(path, file);
		}
		return file;
	};
	const fakeApp = {
		workspace: {
			getActiveViewOfType: () => markdownView,
			iterateAllLeaves: (callback: (leaf: { view: unknown }) => void) => {
				if (workspaceView) callback({ view: workspaceView });
			},
		},
		vault: {
			getAbstractFileByPath: (path: string) => {
				const file = getDiskFileIdentity(path);
				abstractFileLookups++;
				options.onGetAbstractFile?.(path, file, abstractFileLookups);
				return file;
			},
			read: async (file: { path: string }) => {
				const content = diskFiles.get(file.path) ?? "";
				await options.onRead?.();
				return options.stripBomOnVaultRead && content.charCodeAt(0) === 0xfeff
					? content.slice(1)
					: content;
			},
			adapter: {
				read: async (path: string) => diskFiles.get(path) ?? "",
			},
			modify: async (file: { path: string }, content: string) => {
				modifyCalls++;
				diskFiles.set(file.path, content);
			},
			...(options.supportsAtomicProcess === false ? {} : {
				process: async (
					file: { path: string },
					update: (latestContent: string) => string,
				) => {
					processCalls++;
					await options.onBeforeProcess?.();
					const nextContent = update(diskFiles.get(file.path) ?? "");
					diskFiles.set(file.path, nextContent);
					await options.onAfterProcess?.();
					return nextContent;
				},
			}),
			create: async (path: string, content: string) => {
				await options.onBeforeCreate?.();
				if (diskFiles.has(path)) throw new Error(`File already exists: ${path}`);
				diskFiles.set(path, content);
				const file = makeDiskFileIdentity(path, byteLength(content));
				diskFileIdentities.set(path, file);
				if (path === filePath) currentDiskFile = file;
				await options.onAfterCreate?.();
				return file;
			},
			delete: async (_file: { path: string }) => {
				hardDeleteCalls++;
			},
			createFolder: async () => {},
		},
		fileManager: {
			renameFile: async (file: { path: string }, newPath: string) => {
				renameCalls++;
				await options.onBeforeRename?.();
				const oldPath = file.path;
				if (!diskFiles.has(oldPath)) throw new Error(`File not found: ${oldPath}`);
				if (diskFiles.has(newPath)) throw new Error(`File already exists: ${newPath}`);
				const content = diskFiles.get(oldPath) ?? "";
				diskFiles.delete(oldPath);
				diskFileIdentities.delete(oldPath);
				diskFiles.set(newPath, content);
				Object.assign(file, { path: newPath, stat: { size: content.length } });
				diskFileIdentities.set(newPath, file as TFile);
				await options.onAfterRename?.();
			},
			...(options.trashBehavior === "missing" ? {} : {
				trashFile: async (file: { path: string }) => {
					trashAttempts++;
					await options.onBeforeTrash?.();
					if (options.trashBehavior === "throw") {
						throw new Error("deterministic trash failure");
					}
					deleteCalls.push(file.path);
					diskFiles.delete(file.path);
					diskFileIdentities.delete(file.path);
					await options.onAfterTrash?.();
				},
			}),
		},
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mirror = new DiskMirror(fakeApp as any, fakeVaultSync as any, fakeEditorBindings as any, false);
	mirror.setMarkdownPathSyncabilityPredicate(options.isMarkdownPathSyncable ?? (() => true));
	mirror.setRemoteProjectionAdmissionPredicate(
		options.isRemoteProjectionAllowed ?? (() => true),
	);
	if (options.captureRemoteProjectionAdmission) {
		mirror.setRemoteProjectionAdmissionProvider(
			options.captureRemoteProjectionAdmission,
		);
	}
	if (options.baselineHashProvider) {
		mirror.setDiskBaselineHashProvider(options.baselineHashProvider);
	}
	if (options.baselineTextProvider) {
		mirror.setDiskBaselineTextProvider(options.baselineTextProvider);
	}

	return {
		doc,
		ytext,
		fakeProvider,
		meta,
		mirror,
		diskFiles,
		deleteCalls,
		getTrashAttempts: () => trashAttempts,
		getHardDeleteCalls: () => hardDeleteCalls,
		getEnsureFileCalls: () => ensureFileCalls,
		getProcessCalls: () => processCalls,
		getModifyCalls: () => modifyCalls,
		getRenameCalls: () => renameCalls,
		getCurrentDiskFile: () => diskFiles.has(filePath) ? currentDiskFile : null,
		getDiskFileAt: (path: string) => getDiskFileIdentity(path),
		renameDiskFile: async (oldPath: string, newPath: string) => {
			const file = getDiskFileIdentity(oldPath);
			if (!file) throw new Error(`File not found: ${oldPath}`);
			await fakeApp.fileManager.renameFile(file, newPath);
		},
		replaceDiskFileIdentity: (content: string) => {
			// Model delete + recreate at the same path. The bytes can be identical,
			// but Obsidian exposes a new TFile object for the new filesystem entry.
			diskFiles.set(filePath, content);
			currentDiskFile = makeDiskFileIdentity(filePath, byteLength(content));
			diskFileIdentities.set(filePath, currentDiskFile);
		},
		replaceDiskFileIdentityAt: (path: string, content: string) => {
			// Same ABA model for rename destinations and arbitrary vault paths.
			diskFiles.set(path, content);
			const replacement = makeDiskFileIdentity(path, byteLength(content));
			diskFileIdentities.set(path, replacement);
			if (path === filePath) currentDiskFile = replacement;
			return replacement;
		},
		advanceDiskFileRevision: () => {
			const file = getDiskFileIdentity(filePath);
			if (!file) throw new Error("File not found while advancing revision");
			file.stat.mtime = (file.stat.mtime ?? 0) + 1;
			file.stat.size = diskFiles.get(filePath)?.length ?? 0;
		},
		occupyPathWithNonFile: () => {
			nonFilePathOccupants.set(filePath, { path: filePath });
		},
		hasNonFilePathOccupant: () => nonFilePathOccupants.has(filePath),
		setAuthoritativeDeleteFingerprint: (fingerprint: string | null) => {
			authoritativeDeleteFingerprint = fingerprint;
		},
		invalidateEditorAuthority: () => {
			editorAuthorityEpoch++;
		},
		emitMetaChanges: (batch: MetaChangeBatch) => {
			if (!metaChangeObserver) throw new Error("metadata observer is not started");
			metaChangeObserver(batch);
		},
	};
}

// ── Test 2c: provider projection waits for shared policy readiness ────────────

console.log("\n--- Test 2c: provider projection is fenced without blocking local scheduling ---");
{
	const fixture = makeHarness({
		isRemoteProjectionAllowed: () => false,
	});
	fixture.mirror.startMapObservers();

	fixture.doc.transact(
		() => { fixture.ytext.insert(0, "remote hidden content"); },
		fixture.fakeProvider,
	);
	assert(
		debounceTimerCount(fixture.mirror) === 0,
		"closed policy gate blocks provider Y.Text projection before queue admission",
	);

	fixture.emitMetaChanges({
		origin: fixture.fakeProvider,
		isLocal: false,
		changes: [{
			kind: "added",
			fileId: FILE_ID,
			next: { shape: "flat", path: FILE_PATH },
		}],
	});
	assert(
		debounceTimerCount(fixture.mirror) === 0,
		"closed policy gate blocks provider metadata projection before queue admission",
	);

	const blocked = await fixture.mirror.flushWrite(FILE_PATH, true, {
		requireRemoteProjectionAdmission: true,
	});
	assert(
		blocked.kind === "deferred" &&
			blocked.reason === "remote-projection-not-ready",
		"an explicitly remote-authorized direct flush fails closed",
	);
	assert(
		!fixture.diskFiles.has(FILE_PATH),
		"blocked remote projection creates no disk file",
	);

	fixture.mirror.scheduleWrite(FILE_PATH);
	assert(
		debounceTimerCount(fixture.mirror) === 1,
		"the separate gate does not block ordinary local scheduling",
	);
	clearTimers(fixture.mirror);
	fixture.doc.destroy();
}

console.log("\n--- Test 2c2: queued remote lease survives open deferral but not gate ABA ---");
{
	const gate = new RemoteProjectionPolicyGate();
	gate.close(1);
	gate.open(1);
	let editorContent = "local editor\n";
	const fixture = makeHarness({
		initialDiskContent: "local editor\n",
		openEditorContent: () => editorContent,
		captureRemoteProjectionAdmission: (paths) => {
			const lease = gate.captureLease(paths);
			return lease
				? { isCurrent: () => gate.isLeaseCurrent(lease) }
				: null;
		},
	});
	fixture.ytext.insert(0, "remote content\n");
	fixture.mirror.notifyFileOpened(FILE_PATH);
	const lease = fixture.mirror.captureRemoteProjectionAdmission([FILE_PATH]);
	assert(lease !== null, "the remote observer can capture a generation lease");

	const deferred = await fixture.mirror.flushWrite(FILE_PATH, false, {
		remoteProjectionAdmission: lease!,
	});
	assert(
		deferred.kind === "deferred" && deferred.reason === "open-editor-mismatch",
		"open editor authority defers the remote write",
	);

	gate.close(1);
	gate.open(1);
	editorContent = "remote content\n";
	await fixture.mirror.flushOpenPath(FILE_PATH, "test-stale-provider-lease");
	assert(
		fixture.diskFiles.get(FILE_PATH) === "local editor\n",
		"the deferred write retains its old lease and cannot cross a close/open ABA",
	);
	clearTimers(fixture.mirror);
	fixture.doc.destroy();
}

console.log("\n--- Test 2c3: an in-flight remote write rechecks its lease at the atomic boundary ---");
{
	const gate = new RemoteProjectionPolicyGate();
	gate.close(2);
	gate.open(2);
	let releaseProcess!: () => void;
	let processEntered!: () => void;
	const entered = new Promise<void>((resolve) => { processEntered = resolve; });
	const processGate = new Promise<void>((resolve) => { releaseProcess = resolve; });
	const fixture = makeHarness({
		initialDiskContent: "baseline\n",
		onBeforeProcess: async () => {
			processEntered();
			await processGate;
		},
		captureRemoteProjectionAdmission: (paths) => {
			const lease = gate.captureLease(paths);
			return lease
				? { isCurrent: () => gate.isLeaseCurrent(lease) }
				: null;
		},
	});
	fixture.ytext.insert(0, "remote replacement\n");
	const lease = fixture.mirror.captureRemoteProjectionAdmission([FILE_PATH]);
	const write = fixture.mirror.flushWrite(FILE_PATH, true, {
		remoteProjectionAdmission: lease!,
		expectedDiskContent: "baseline\n",
	});
	await entered;
	gate.close(3);
	gate.open(3);
	releaseProcess();
	const result = await write;
	assert(
		result.kind === "deferred" && result.reason === "remote-projection-not-ready",
		"the stale operation is rejected immediately before atomic disk mutation",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === "baseline\n",
		"an invalidated in-flight lease writes no bytes",
	);
	fixture.doc.destroy();
}

console.log("\n--- Test 2c4: provider reopen waits for in-flight remote trash ---");
{
	const gate = new RemoteProjectionPolicyGate();
	gate.close(20);
	gate.open(20);
	let releaseTrash!: () => void;
	let reportTrashEntered!: () => void;
	const trashEntered = new Promise<void>((resolve) => { reportTrashEntered = resolve; });
	const trashGate = new Promise<void>((resolve) => { releaseTrash = resolve; });
	const fixture = makeHarness({
		initialDiskContent: "clean delete baseline\n",
		onBeforeTrash: async () => {
			reportTrashEntered();
			await trashGate;
		},
		captureRemoteProjectionAdmission: (paths) => {
			const lease = gate.captureLease(paths);
			return lease
				? {
					isCurrent: () => gate.isLeaseCurrent(lease),
					enterCriticalSection: () => gate.enterCriticalSection(lease),
				}
				: null;
		},
	});
	fixture.ytext.insert(0, "clean delete baseline\n");
	fixture.setAuthoritativeDeleteFingerprint("delete-before-reconnect");

	const deletion = (fixture.mirror as unknown as {
		handleRemoteDelete: (
			path: string,
			options: { baselineText?: string | null },
		) => Promise<void>;
	}).handleRemoteDelete(FILE_PATH, { baselineText: "clean delete baseline\n" });
	await trashEntered;
	gate.close(21);
	let retryRequested = 0;
	assert(
		gate.open(21, () => { retryRequested++; }) === false,
		"provider projection cannot reopen while an older recoverable trash is active",
	);
	assert(gate.readyGeneration === null, "trash barrier keeps the next generation closed");
	releaseTrash();
	await deletion;
	assert(retryRequested === 1, "trash settlement requests one fresh policy-open attempt");
	assert(gate.open(21) === true, "the next generation opens only after trash settles");

	fixture.doc.destroy();
}

console.log("\n--- Test 2c5: provider reopen waits for in-flight remote rename ---");
{
	const targetPath = "notes/renamed-after-reconnect.md";
	const gate = new RemoteProjectionPolicyGate();
	gate.close(30);
	gate.open(30);
	let releaseRename!: () => void;
	let reportRenameEntered!: () => void;
	const renameEntered = new Promise<void>((resolve) => { reportRenameEntered = resolve; });
	const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
	const fixture = makeHarness({
		initialDiskContent: "rename source\n",
		onBeforeRename: async () => {
			reportRenameEntered();
			await renameGate;
		},
		captureRemoteProjectionAdmission: (paths) => {
			const lease = gate.captureLease(paths);
			return lease
				? {
					isCurrent: () => gate.isLeaseCurrent(lease),
					enterCriticalSection: () => gate.enterCriticalSection(lease),
				}
				: null;
		},
	});
	fixture.ytext.insert(0, "rename source\n");
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	const rename = (fixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);
	await renameEntered;
	gate.close(31);
	let retryRequested = 0;
	assert(
		gate.open(31, () => { retryRequested++; }) === false,
		"provider projection cannot reopen while an older rename is active",
	);
	assert(gate.readyGeneration === null, "rename barrier keeps the next generation closed");
	releaseRename();
	await rename;
	assert(retryRequested === 1, "rename settlement requests one fresh policy-open attempt");
	assert(gate.open(31) === true, "the next generation opens only after rename settles");

	clearTimers(fixture.mirror);
	fixture.doc.destroy();
}

console.log("\n--- Test 2d: provider delete and rename are fenced by the same gate ---");
{
	const deleteFixture = makeHarness({
		initialDiskContent: "local bytes survive\n",
		isRemoteProjectionAllowed: () => false,
	});
	deleteFixture.ytext.insert(0, "local bytes survive\n");
	deleteFixture.setAuthoritativeDeleteFingerprint("remote-delete-v1");

	await (deleteFixture.mirror as unknown as {
		handleRemoteDelete: (path: string) => Promise<void>;
	}).handleRemoteDelete(FILE_PATH);
	assert(
		deleteFixture.diskFiles.get(FILE_PATH) === "local bytes survive\n",
		"closed policy gate prevents provider delete from mutating disk",
	);
	assert(
		deleteFixture.getTrashAttempts() === 0 &&
			deleteFixture.getHardDeleteCalls() === 0,
		"blocked provider delete never reaches a delete primitive",
	);
	deleteFixture.doc.destroy();

	const targetPath = "notes/remote-target.md";
	const renameFixture = makeHarness({
		initialDiskContent: "local rename source\n",
		isRemoteProjectionAllowed: () => false,
	});
	renameFixture.ytext.insert(0, "local rename source\n");
	renameFixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	await (renameFixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);
	assert(
		renameFixture.diskFiles.has(FILE_PATH) &&
			!renameFixture.diskFiles.has(targetPath),
		"closed policy gate prevents provider rename from mutating either path",
	);
	assert(
		renameFixture.getRenameCalls() === 0,
		"blocked provider rename never reaches the filesystem rename primitive",
	);
	renameFixture.doc.destroy();
}

// ── Test 2b: excluded remote paths never enter the write queue ───────────────

console.log("\n--- Test 2b: excluded remote path is never scheduled or written ---");
{
	const { doc, ytext, fakeProvider, mirror, diskFiles } = makeHarness({
		isMarkdownPathSyncable: () => false,
	});
	mirror.startMapObservers();

	doc.transact(() => { ytext.insert(0, "remote hidden content"); }, fakeProvider);
	assert(debounceTimerCount(mirror) === 0, "excluded provider update does not enter the debounce queue");

	const result = await mirror.flushWrite(FILE_PATH, true);
	assert(result.kind === "deferred" && result.reason === "path-excluded", "excluded direct flush is deferred");
	assert(!diskFiles.has(FILE_PATH), "excluded direct flush does not create a disk file");

	doc.destroy();
}

// Private-field accessors — DiskMirror internals are not exposed publicly
function debounceTimerCount(m: DiskMirror): number {
	return (m as unknown as { debounceTimers: Map<unknown, unknown> }).debounceTimers.size;
}
function pendingOpenWriteCount(m: DiskMirror): number {
	return (m as unknown as { pendingOpenWrites: Set<unknown> }).pendingOpenWrites.size;
}
function writeQueueSize(m: DiskMirror): number {
	return (m as unknown as { writeQueue: Set<unknown> }).writeQueue.size;
}
function clearTimers(m: DiskMirror): void {
	const dm = m as unknown as {
		debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
		openWriteTimers: Map<string, ReturnType<typeof setTimeout>>;
		pendingOpenWrites: Set<string>;
	};
	for (const t of dm.debounceTimers.values()) clearTimeout(t);
	dm.debounceTimers.clear();
	for (const t of dm.openWriteTimers.values()) clearTimeout(t);
	dm.openWriteTimers.clear();
	dm.pendingOpenWrites.clear();
}

// ── Test 1: afterTransaction (closed file) — recovery origins skip write ──────

console.log("\n--- Test 1: afterTransaction — recovery origins do not schedule write (closed file) ---");
{
	const { doc, ytext, mirror } = makeHarness();
	mirror.startMapObservers();

	const recoveryOrigins = [
		ORIGIN_DISK_SYNC,
		ORIGIN_DISK_SYNC_RECOVER_BOUND,
		ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
		ORIGIN_EDITOR_HEALTH_HEAL,
		ORIGIN_EDITOR_AUTHORITY_SHIELD,
		ORIGIN_EDITOR_EXTERNAL_RELOAD_REJECT,
		ORIGIN_RESTORE,
		ORIGIN_SEED,
	];

	for (const origin of recoveryOrigins) {
		// Insert then delete to leave content unchanged; both use the recovery origin
		doc.transact(() => { ytext.insert(0, "x"); }, origin);
		doc.transact(() => { ytext.delete(0, 1); }, origin);

		assert(
			debounceTimerCount(mirror) === 0,
			`"${origin}" → afterTxn: no debounce timer set (closed file, write skipped)`,
		);
	}

	assert(writeQueueSize(mirror) === 0, "writeQueue empty after all recovery origins");
	doc.destroy();
}

// ── Test 2: afterTransaction (closed file) — provider origin schedules write ──

console.log("\n--- Test 2: afterTransaction — provider (remote) origin schedules write (closed file) ---");
{
	const { doc, ytext, fakeProvider, mirror } = makeHarness();
	mirror.startMapObservers();

	doc.transact(() => { ytext.insert(0, "remote content"); }, fakeProvider);

	assert(
		debounceTimerCount(mirror) === 1,
		"provider origin → afterTxn: debounce timer set (write will be scheduled)",
	);
	assert(writeQueueSize(mirror) === 0, "write still debouncing — not yet in writeQueue");

	clearTimers(mirror);
	doc.destroy();
}

// ── Test 3: per-file text observer (open file) — recovery origins skip write ──

console.log("\n--- Test 3: per-file text observer — recovery origins do not schedule write (open file) ---");
{
	const { doc, ytext, mirror } = makeHarness();
	mirror.notifyFileOpened(FILE_PATH);

	const recoveryOrigins = [ORIGIN_DISK_SYNC_RECOVER_BOUND, ORIGIN_DISK_SYNC, ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER];

	for (const origin of recoveryOrigins) {
		doc.transact(() => { ytext.insert(0, "x"); }, origin);
		doc.transact(() => { ytext.delete(0, 1); }, origin);

		assert(
			pendingOpenWriteCount(mirror) === 0,
			`"${origin}" → text observer: no pending open write (open file, write skipped)`,
		);
	}

	clearTimers(mirror);
	doc.destroy();
}

// ── Test 4: per-file text observer (open file) — provider origin schedules ────

console.log("\n--- Test 4: per-file text observer — provider origin schedules write (open file) ---");
{
	const { doc, ytext, fakeProvider, mirror } = makeHarness();
	mirror.notifyFileOpened(FILE_PATH);

	doc.transact(() => { ytext.insert(0, "remote content"); }, fakeProvider);

	assert(
		pendingOpenWriteCount(mirror) === 1,
		"provider origin → text observer: pending open write scheduled (open file)",
	);

	clearTimers(mirror);
	doc.destroy();
}

// ── Test 5: mixed cycle — recovery then remote — only remote triggers write ───

console.log("\n--- Test 5: mixed cycle — recovery then provider — only provider triggers write ---");
{
	const { doc, ytext, fakeProvider, mirror } = makeHarness();
	mirror.startMapObservers();

	// Recovery pass — simulates disk reconciliation
	doc.transact(() => { ytext.insert(0, "reconciled disk content"); }, ORIGIN_DISK_SYNC_RECOVER_BOUND);

	assert(debounceTimerCount(mirror) === 0, "after recovery pass: no debounce timer");
	assert(writeQueueSize(mirror) === 0, "after recovery pass: writeQueue empty");

	// Second recovery pass is no-op (same content) — no write
	doc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, "reconciled disk content"); }, ORIGIN_DISK_SYNC_RECOVER_BOUND);

	assert(debounceTimerCount(mirror) === 0, "after second recovery pass: still no debounce timer");

	// Remote update from another device — this SHOULD schedule a write
	doc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, "update from another device"); }, fakeProvider);

	assert(debounceTimerCount(mirror) === 1, "after provider update: debounce timer set");

	clearTimers(mirror);
	doc.destroy();
}

// ── Test 6: startup-open workspace gap schedules open write, not closed write ─

console.log("\n--- Test 6: provider update to workspace-open file schedules open write before notifyFileOpened ---");
{
	const { doc, ytext, fakeProvider, mirror } = makeHarness({ openEditorContent: "local editor" });
	mirror.startMapObservers();

	doc.transact(() => { ytext.insert(0, "remote content"); }, fakeProvider);

	assert(
		pendingOpenWriteCount(mirror) === 1,
		"workspace-open provider update is treated as an open-file write",
	);
	assert(
		debounceTimerCount(mirror) === 0,
		"workspace-open provider update does not use closed-file debounce",
	);

	clearTimers(mirror);
	doc.destroy();
}

console.log("\n--- Test 6b: an opaque open Base blocks an unprovable content update ---");
{
	const basePath = "BACKLOG/BACKLOG.base";
	const clean = "views:\n  - type: table\n    name: Local\n";
	const remote = "views:\n  - type: table\n    name: Remote\n";
	const baselineHash = await contentBaselineHash(clean);
	const fixture = makeHarness({
		filePath: basePath,
		opaqueOpenFileView: true,
		initialDiskContent: clean,
		baselineHashProvider: () => baselineHash,
	});
	fixture.ytext.insert(0, remote);

	const result = await fixture.mirror.flushWrite(basePath, true);
	assert(
		result.kind === "deferred" && result.reason === "open-editor-mismatch",
		"opaque open Base defers until its host authority can be proven absent",
	);
	assert(fixture.diskFiles.get(basePath) === clean, "opaque open Base preserves its local YAML bytes");
	assert(fixture.getProcessCalls() === 0, "opaque open Base never reaches Vault.process");
	assert(fixture.getModifyCalls() === 0, "open Base update never uses the racy modify fallback");
	assert(fixture.getRenameCalls() === 0, "open Base update performs zero visible backup renames");

	fixture.doc.destroy();
}

// ── Test 7: forced flush does not overwrite an open editor mismatch ──────────

console.log("\n--- Test 7: forced open flush does not overwrite disk when editor differs from CRDT ---");
{
	const { ytext, mirror, diskFiles, doc } = makeHarness({
		openEditorContent: "LOCAL_ON_EDITOR\n",
		initialDiskContent: "LOCAL_ON_EDITOR\n",
	});
	ytext.insert(0, "REMOTE_FROM_CRDT\n");

	const result = await mirror.flushWrite(FILE_PATH, true);

	assert(
		diskFiles.get(FILE_PATH) === "LOCAL_ON_EDITOR\n",
		"force flush preserves disk when an open editor carries different content",
	);
	assert(
		result.kind === "deferred" && result.reason === "open-editor-mismatch",
		"force flush reports open-editor mismatch deferral",
	);

	doc.destroy();
}

// ── Test 8: async read race — open editor changes after preflight ────────────

console.log("\n--- Test 8: forced open flush rechecks editor after async read ---");
{
	let editorContent = "REMOTE_FROM_CRDT\n";
	let readCount = 0;
	const { ytext, mirror, diskFiles, doc } = makeHarness({
		openEditorContent: () => editorContent,
		initialDiskContent: "DISK_BEFORE\n",
		onRead: () => {
			readCount++;
			if (readCount === 1) {
				editorContent = "USER_TYPED_DURING_READ\n";
			}
		},
	});
	ytext.insert(0, "REMOTE_FROM_CRDT\n");

	const result = await mirror.flushWrite(FILE_PATH, true);

	assert(
		diskFiles.get(FILE_PATH) === "DISK_BEFORE\n",
		"force flush does not write stale CRDT content when the editor changes during read",
	);
	assert(
		result.kind === "deferred" && result.reason === "authority-stale",
		"async editor race reports exact lease invalidation",
	);

	doc.destroy();
}

console.log("\n--- Test 8b: forced write rejects a lease invalidated at atomic commit ---");
{
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		openEditorContent: "REMOTE_FROM_CRDT\n",
		initialDiskContent: "DISK_BEFORE\n",
		onBeforeProcess: () => fixture.invalidateEditorAuthority(),
	});
	fixture.ytext.insert(0, "REMOTE_FROM_CRDT\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: "DISK_BEFORE\n",
	});

	assert(
		result.kind === "deferred" && result.reason === "authority-stale",
		"forced write rejects the exact editor authority lease after invalidation",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === "DISK_BEFORE\n",
		"stale editor authority writes zero disk bytes",
	);
	fixture.doc.destroy();
}

for (const editorAuthorityKind of ["transitioning", "multiple"] as const) {
	console.log(`\n--- Test 8c: ${editorAuthorityKind} authority blocks forced writes ---`);
	const fixture = makeHarness({
		openEditorContent: "REMOTE_FROM_CRDT\n",
		initialDiskContent: "DISK_BEFORE\n",
		editorAuthorityKind,
	});
	fixture.ytext.insert(0, "REMOTE_FROM_CRDT\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: "DISK_BEFORE\n",
	});

	assert(
		result.kind === "deferred" && result.reason === "open-editor-mismatch",
		`${editorAuthorityKind} authority fails closed instead of borrowing raw editor bytes`,
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === "DISK_BEFORE\n",
		`${editorAuthorityKind} authority permits zero disk mutation`,
	);
	fixture.doc.destroy();
}

// ── Test 9: async read race — CRDT changes after the write snapshot ──────────

console.log("\n--- Test 9: flush retries when CRDT changes during async read ---");
{
	let readCount = 0;
	const { ytext, mirror, diskFiles, doc } = makeHarness({
		initialDiskContent: "DISK_BEFORE\n",
		onRead: () => {
			readCount++;
			if (readCount === 1) {
				ytext.delete(0, ytext.length);
				ytext.insert(0, "NEW_CRDT\n");
			}
		},
	});
	ytext.insert(0, "OLD_CRDT\n");

	await mirror.flushWrite(FILE_PATH, true);

	assert(readCount >= 2, "flush retries after detecting a stale CRDT snapshot");
	assert(
		diskFiles.get(FILE_PATH) === "NEW_CRDT\n",
		"flush writes the latest CRDT content instead of the stale snapshot",
	);

	doc.destroy();
}

// ── Test 10: atomic process rejects a disk edit during write preparation ──────

console.log("\n--- Test 10: atomic process preserves a disk edit made during write preparation ---");
{
	let mutateBeforeProcess: (() => void) | null = null;
	const fixture = makeHarness({
		initialDiskContent: "DISK_BEFORE\n",
		onBeforeProcess: () => mutateBeforeProcess?.(),
	});
	mutateBeforeProcess = () => {
		fixture.diskFiles.set(FILE_PATH, "EXTERNAL_DURING_PREP\n");
	};
	fixture.ytext.insert(0, "REMOTE_CRDT\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true);

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"atomic write reports a stale disk snapshot instead of overwriting it",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === "EXTERNAL_DURING_PREP\n",
		"atomic write preserves the external edit that landed before commit",
	);
	assert(fixture.getProcessCalls() === 1, "existing-file write uses Vault.process when available");
	assert(fixture.getModifyCalls() === 0, "atomic existing-file write does not fall back to Vault.modify");

	fixture.doc.destroy();
}

// ── Test 11: hosts without atomic process never attempt a racy modify ─────────

console.log("\n--- Test 11: missing atomic process defers without Vault.modify ---");
{
	let fixture!: ReturnType<typeof makeHarness>;
	let readCount = 0;
	fixture = makeHarness({
		initialDiskContent: "DISK_BEFORE\n",
		supportsAtomicProcess: false,
		onRead: () => {
			readCount++;
			if (readCount === 1) {
				fixture.diskFiles.set(FILE_PATH, "EXTERNAL_AFTER_FIRST_READ\n");
			}
		},
	});
	fixture.ytext.insert(0, "REMOTE_CRDT\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true);

	assert(readCount === 1, "unsupported host stops after the planning read");
	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"unsupported host reports a conservative deferral",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === "EXTERNAL_AFTER_FIRST_READ\n",
		"unsupported host preserves the external edit",
	);
	assert(fixture.getProcessCalls() === 0, "unavailable Vault.process is never called");
	assert(fixture.getModifyCalls() === 0, "racy Vault.modify fallback is never used");

	fixture.doc.destroy();
}

// ── Test 12: caller-provided disk authority snapshot is a CAS precondition ───

console.log("\n--- Test 12: expectedDiskContent rejects a stale reconciliation plan ---");
{
	const fixture = makeHarness({ initialDiskContent: "DISK_NEWER_THAN_PLAN\n" });
	fixture.ytext.insert(0, "CRDT_FROM_STALE_PLAN\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: "DISK_SEEN_BY_PLANNER\n",
	});

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"stale caller snapshot is rejected with an explicit disk-changed deferral",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === "DISK_NEWER_THAN_PLAN\n",
		"stale reconciliation plan cannot overwrite newer disk content",
	);
	assert(fixture.getProcessCalls() === 0, "snapshot mismatch is rejected before atomic commit");
	assert(fixture.getModifyCalls() === 0, "snapshot mismatch performs no fallback modify");

	fixture.doc.destroy();
}

console.log("\n--- Test 12a: Vault.process accepts the same document snapshot with a raw BOM ---");
{
	const rawDiskContent = "\ufeffsame logical authority\r\nsecond line\r\n";
	const documentDiskContent = rawDiskContent.slice(1);
	const settledCrdtContent = "same logical authority\nsecond line\n";
	const fixture = makeHarness({
		initialDiskContent: rawDiskContent,
		stripBomOnVaultRead: true,
	});
	fixture.ytext.insert(0, settledCrdtContent);

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: documentDiskContent,
	});

	assert(
		result.kind === "written",
		"atomic CAS recognizes Vault.read's BOM-stripped snapshot inside raw Vault.process",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === settledCrdtContent,
		"representation-only raw disk bytes settle to the authoritative Y.Text snapshot",
	);
	assert(fixture.getProcessCalls() === 1, "representation settlement uses one atomic process");

	fixture.doc.destroy();
}

console.log("\n--- Test 12a1: a meaningful raw edit at process entry still aborts the CAS ---");
{
	const rawDiskContent = "\ufeffsame logical authority\r\nsecond line\r\n";
	const newerRawExternal = "\ufeffdifferent external authority\r\nsecond line\r\n";
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: rawDiskContent,
		stripBomOnVaultRead: true,
		onBeforeProcess: () => {
			fixture.diskFiles.set(FILE_PATH, newerRawExternal);
		},
	});
	fixture.ytext.insert(0, "same logical authority\nsecond line\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: rawDiskContent.slice(1),
	});

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"BOM-aware atomic CAS rejects a meaningful external change at process entry",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === newerRawExternal,
		"the newer raw external candidate remains byte-for-byte intact",
	);
	assert(fixture.getProcessCalls() === 1, "process-entry race is detected inside the atomic callback");

	fixture.doc.destroy();
}

console.log("\n--- Test 12a2: raw-process equivalence never erases a CRLF content precondition ---");
{
	const rawDiskContent = "\ufeffsame logical authority\r\nsecond line\r\n";
	const staleLfPlan = "same logical authority\nsecond line\n";
	const fixture = makeHarness({
		initialDiskContent: rawDiskContent,
		stripBomOnVaultRead: true,
	});
	fixture.ytext.insert(0, "new CRDT content\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: staleLfPlan,
	});

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"BOM compatibility does not normalize CRLF away from the exact document CAS",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === rawDiskContent,
		"a line-ending mismatch preserves the raw external disk snapshot",
	);
	assert(fixture.getProcessCalls() === 0, "line-ending mismatch is rejected before atomic commit");

	fixture.doc.destroy();
}

// ── Test 12b: file identity closes identical-content ABA ───────────────

console.log("\n--- Test 12b: restore identity CAS rejects identical-bytes delete/recreate ABA ---");
{
	const reviewedDiskContent = "DISK_REVIEWED_BEFORE_RESTORE\n";
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: reviewedDiskContent,
		onBeforeProcess: () => {
			// The path disappears and is recreated with byte-for-byte identical
			// content after restore preparation but before the atomic callback.
			fixture.replaceDiskFileIdentity(reviewedDiskContent);
		},
	});
	const reviewedDiskFile = fixture.getCurrentDiskFile();
	if (!reviewedDiskFile) throw new Error("fixture must expose the reviewed file identity");
	fixture.ytext.insert(0, "SNAPSHOT_VERSION\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: reviewedDiskContent,
		expectedDiskFile: reviewedDiskFile,
	});

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"new TFile identity invalidates restore even when the replacement bytes are identical",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === reviewedDiskContent,
		"snapshot bytes never overwrite the identically-valued replacement file",
	);
	assert(
		fixture.getProcessCalls() === 1,
		"identity is rechecked inside the atomic process boundary",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 12b2: restore revision CAS rejects same-TFile ABA before queued flush ---");
{
	const reviewedDiskContent = "DISK_REVIEWED_REVISION\n";
	const fixture = makeHarness({ initialDiskContent: reviewedDiskContent });
	const reviewedDiskFile = fixture.getCurrentDiskFile();
	if (!reviewedDiskFile) throw new Error("fixture must expose the reviewed file identity");
	const reviewedRevision = {
		ctime: reviewedDiskFile.stat.ctime,
		mtime: reviewedDiskFile.stat.mtime,
		size: reviewedDiskFile.stat.size,
	};
	fixture.ytext.insert(0, "SNAPSHOT_REVISION_VERSION\n");

	// flushWrite enters a per-path Promise chain. A same-TFile local save can
	// advance stat before that queued work begins even if its final bytes equal
	// the reviewed content.
	const writePromise = fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: reviewedDiskContent,
		expectedDiskFile: reviewedDiskFile,
		expectedDiskRevision: reviewedRevision,
	});
	fixture.advanceDiskFileRevision();
	const result = await writePromise;

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"new same-TFile stat episode invalidates restore before the queued write",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === reviewedDiskContent,
		"snapshot bytes cannot overwrite a same-bytes local save episode",
	);
	assert(fixture.getProcessCalls() === 0, "revision mismatch is rejected before Vault.process");

	fixture.doc.destroy();
}

console.log("\n--- Test 12b3: unchanged restore rechecks revision after final readback ---");
{
	const reviewedDiskContent = "ALREADY_RESTORED\n";
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: reviewedDiskContent,
		onGetAbstractFile: (_path, _file, callCount) => {
			if (callCount === 6) {
				// This runs after isSettledDiskSnapshotCurrent's last identity/stat
				// read, but before settleUnchangedWrite resumes from awaiting it.
				queueMicrotask(() => fixture.advanceDiskFileRevision());
			}
		},
	});
	fixture.ytext.insert(0, reviewedDiskContent);
	const reviewedDiskFile = fixture.getCurrentDiskFile();
	if (!reviewedDiskFile) throw new Error("fixture must expose the reviewed file identity");
	const reviewedRevision = {
		ctime: reviewedDiskFile.stat.ctime,
		mtime: reviewedDiskFile.stat.mtime,
		size: reviewedDiskFile.stat.size,
	};
	let baselineCalls = 0;
	fixture.mirror.setDiskWriteCallback(() => { baselineCalls++; });

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: reviewedDiskContent,
		expectedDiskFile: reviewedDiskFile,
		expectedDiskRevision: reviewedRevision,
		recordBaseline: true,
	});

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"same-TFile save after readback is not reported as unchanged settlement",
	);
	assert(baselineCalls === 0, "stale unchanged episode never advances the durable baseline");
	assert(
		fixture.diskFiles.get(FILE_PATH) === reviewedDiskContent,
		"unchanged revision race leaves disk bytes untouched",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 12c: ordinary write pins the initially-read TFile identity ---");
{
	const reviewedDiskContent = "ORDINARY_DISK_BEFORE_WRITE\n";
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: reviewedDiskContent,
		onBeforeProcess: () => {
			// No expectedDiskFile option is supplied. DiskMirror must still pin the
			// TFile it actually read and reject a same-bytes replacement at commit.
			fixture.replaceDiskFileIdentity(reviewedDiskContent);
		},
	});
	fixture.ytext.insert(0, "REMOTE_ORDINARY_WRITE\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true);

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"ordinary flush rejects same-bytes TFile replacement without caller identity options",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === reviewedDiskContent,
		"ordinary flush never overwrites the replacement filesystem entry",
	);
	assert(fixture.getProcessCalls() === 1, "ordinary identity is fenced inside Vault.process");

	fixture.doc.destroy();
}

// ── Test 13: revival invalidates an in-flight remote delete ───────────────────

console.log("\n--- Test 13: remote revival cancels an older in-flight delete ---");
{
	let releaseFirstRead!: () => void;
	let signalFirstRead!: () => void;
	const firstReadStarted = new Promise<void>((resolve) => {
		signalFirstRead = resolve;
	});
	const firstReadReleased = new Promise<void>((resolve) => {
		releaseFirstRead = resolve;
	});
	let readCount = 0;
	const fixture = makeHarness({
		initialDiskContent: "CLEAN_BASELINE\n",
		onRead: async () => {
			readCount++;
			if (readCount === 1) {
				signalFirstRead();
				await firstReadReleased;
			}
		},
	});
	fixture.ytext.insert(0, "CLEAN_BASELINE\n");
	fixture.mirror.startMapObservers();
	fixture.setAuthoritativeDeleteFingerprint("delete-episode-1");

	const deletePromise = (
		fixture.mirror as unknown as {
			handleRemoteDelete: (
				path: string,
				options: { baselineText?: string | null },
			) => Promise<void>;
		}
	).handleRemoteDelete(FILE_PATH, { baselineText: "CLEAN_BASELINE\n" });

	await firstReadStarted;
	fixture.setAuthoritativeDeleteFingerprint(null);
	fixture.emitMetaChanges({
		origin: fixture.fakeProvider,
		isLocal: false,
		changes: [{ kind: "revived", fileId: FILE_ID, path: FILE_PATH }],
	});
	releaseFirstRead();
	await deletePromise;

	assert(fixture.deleteCalls.length === 0, "revival prevents the older delete handler from deleting disk");
	assert(
		fixture.diskFiles.get(FILE_PATH) === "CLEAN_BASELINE\n",
		"revival leaves the local file intact",
	);
	assert(
		debounceTimerCount(fixture.mirror) === 1,
		"older delete handler does not clear the revival write that replaced it",
	);

	clearTimers(fixture.mirror);
	fixture.doc.destroy();
}

console.log("\n--- Test 13b: remote tombstone serializes with an in-flight write ---");
{
	let releaseProcess!: () => void;
	let signalProcess!: () => void;
	const processStarted = new Promise<void>((resolve) => { signalProcess = resolve; });
	const processReleased = new Promise<void>((resolve) => { releaseProcess = resolve; });
	const fixture = makeHarness({
		initialDiskContent: "CLEAN_BASELINE\n",
		onBeforeProcess: async () => {
			signalProcess();
			await processReleased;
		},
	});
	fixture.ytext.insert(0, "REMOTE_WRITE_BEFORE_DELETE\n");

	const writePromise = fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: "CLEAN_BASELINE\n",
	});
	await processStarted;
	fixture.setAuthoritativeDeleteFingerprint("delete-during-write");
	const deletePromise = (
		fixture.mirror as unknown as {
			handleRemoteDelete: (
				path: string,
				options: { baselineText?: string | null },
			) => Promise<void>;
		}
	).handleRemoteDelete(FILE_PATH, { baselineText: "CLEAN_BASELINE\n" });
	await Promise.resolve();
	releaseProcess();

	const writeResult = await writePromise;
	await deletePromise;
	assert(
		writeResult.kind === "deferred" && writeResult.reason === "disk-changed-during-write",
		"tombstone aborts the write at the atomic commit fence",
	);
	assert(fixture.deleteCalls.length === 1, "serialized delete runs after the aborted writer releases the path");
	assert(!fixture.diskFiles.has(FILE_PATH), "queued writer cannot resurrect the remotely deleted note");

	fixture.doc.destroy();
}

console.log("\n--- Test 13c: remote edit+delete compares disk with the durable baseline, not tombstoned Y.Text ---");
{
	const cleanDiskBaseline = "CLEAN_DISK_A\n";
	const tombstonedRemoteText = "REMOTE_EDIT_B_THEN_DELETE\n";
	const durableBaselineHash = await contentBaselineHash(cleanDiskBaseline);
	const fixture = makeHarness({
		initialDiskContent: cleanDiskBaseline,
		baselineHashProvider: () => durableBaselineHash,
		baselineTextProvider: () => cleanDiskBaseline,
	});
	fixture.ytext.insert(0, tombstonedRemoteText);
	fixture.setAuthoritativeDeleteFingerprint("remote-edit-delete-episode");

	await (
		fixture.mirror as unknown as {
			handleRemoteDelete: (
				path: string,
				options?: { baselineText?: string | null },
			) => Promise<void>;
		}
	).handleRemoteDelete(FILE_PATH);

	assert(fixture.deleteCalls.length === 1, "clean disk is deleted even when tombstoned Y.Text already contains B");
	assert(!fixture.diskFiles.has(FILE_PATH), "stale clean A is not revived over the remote B+delete intent");
	assert(!fixture.mirror.isPreservedUnresolved(FILE_PATH), "verified durable equality needs no unresolved marker");

	fixture.doc.destroy();
}

console.log("\n--- Test 13c2: remote delete rejects an editor lease invalidated during inspection ---");
{
	const cleanDiskBaseline = "CLEAN_EDITOR_LEASE_BASELINE\n";
	let fixture!: ReturnType<typeof makeHarness>;
	let readCount = 0;
	fixture = makeHarness({
		openEditorContent: cleanDiskBaseline,
		initialDiskContent: cleanDiskBaseline,
		onRead: () => {
			readCount++;
			if (readCount === 1) fixture.invalidateEditorAuthority();
		},
	});
	fixture.ytext.insert(0, cleanDiskBaseline);
	fixture.setAuthoritativeDeleteFingerprint("remote-delete-stale-editor-lease");
	fixture.mirror.recordPreservedUnresolved(FILE_PATH, "remote-delete-missing-baseline");

	await (
		fixture.mirror as unknown as {
			handleRemoteDelete: (
				path: string,
				options: { baselineText?: string | null },
			) => Promise<void>;
		}
	).handleRemoteDelete(FILE_PATH, { baselineText: cleanDiskBaseline });

	assert(readCount === 1, "stale editor lease stops remote delete after its first asynchronous read");
	assert(fixture.deleteCalls.length === 0, "stale editor lease reaches zero trash/delete calls");
	assert(fixture.getEnsureFileCalls() === 0, "stale editor lease reaches zero revival calls");
	assert(fixture.diskFiles.get(FILE_PATH) === cleanDiskBaseline, "stale editor lease preserves disk bytes");
	assert(fixture.mirror.isPreservedUnresolved(FILE_PATH), "stale editor lease clears no prior marker");

	fixture.doc.destroy();
}

for (const editorAuthorityKind of ["transitioning", "multiple"] as const) {
	console.log(`\n--- Test 13c3: ${editorAuthorityKind} authority blocks remote delete ---`);
	const cleanDiskBaseline = `CLEAN_${editorAuthorityKind.toUpperCase()}_BASELINE\n`;
	const fixture = makeHarness({
		openEditorContent: cleanDiskBaseline,
		initialDiskContent: cleanDiskBaseline,
		editorAuthorityKind,
	});
	fixture.ytext.insert(0, cleanDiskBaseline);
	fixture.setAuthoritativeDeleteFingerprint(`remote-delete-${editorAuthorityKind}`);

	await (
		fixture.mirror as unknown as {
			handleRemoteDelete: (
				path: string,
				options: { baselineText?: string | null },
			) => Promise<void>;
		}
	).handleRemoteDelete(FILE_PATH, { baselineText: cleanDiskBaseline });

	assert(fixture.deleteCalls.length === 0, `${editorAuthorityKind} authority permits zero delete calls`);
	assert(fixture.getEnsureFileCalls() === 0, `${editorAuthorityKind} authority permits zero revival calls`);
	assert(fixture.diskFiles.get(FILE_PATH) === cleanDiskBaseline, `${editorAuthorityKind} authority preserves disk`);
	assert(fixture.mirror.isPreservedUnresolved(FILE_PATH), `${editorAuthorityKind} authority quarantines the path`);
	assert(
		fixture.mirror.getPreservedUnresolvedEntries()[0]?.reason === (
			editorAuthorityKind === "multiple"
				? "remote-delete-multiple-open-editor-authorities"
				: "remote-delete-open-editor-read-failed"
		),
		`${editorAuthorityKind} authority retains the existing bounded quarantine reason`,
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 13d: same-bytes delete/recreate during final delete read is preserved ---");
{
	const cleanDiskBaseline = "CLEAN_DISK_IDENTITY_A\n";
	let readCount = 0;
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: cleanDiskBaseline,
		onRead: () => {
			readCount++;
			if (readCount === 2) {
				fixture.replaceDiskFileIdentity(cleanDiskBaseline);
			}
		},
	});
	fixture.ytext.insert(0, cleanDiskBaseline);
	fixture.setAuthoritativeDeleteFingerprint("remote-delete-disk-aba");

	await (
		fixture.mirror as unknown as {
			handleRemoteDelete: (
				path: string,
				options: { baselineText?: string | null },
			) => Promise<void>;
		}
	).handleRemoteDelete(FILE_PATH, { baselineText: cleanDiskBaseline });

	assert(readCount === 2, "delete path reaches its final compare read");
	assert(fixture.deleteCalls.length === 0, "replacement TFile is never passed to trash/delete");
	assert(fixture.diskFiles.get(FILE_PATH) === cleanDiskBaseline, "same-bytes replacement survives the stale delete");
	assert(fixture.mirror.isPreservedUnresolved(FILE_PATH), "disk ABA is quarantined for explicit resolution");

	fixture.doc.destroy();
}

console.log("\n--- Test 13d2: same-bytes replacement between delete reads is preserved ---");
{
	const cleanDiskBaseline = "CLEAN_DISK_BETWEEN_READ_ABA\n";
	let readCount = 0;
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: cleanDiskBaseline,
		onRead: () => {
			readCount++;
			if (readCount === 1) {
				fixture.replaceDiskFileIdentity(cleanDiskBaseline);
			}
		},
	});
	fixture.ytext.insert(0, cleanDiskBaseline);
	fixture.setAuthoritativeDeleteFingerprint("remote-delete-between-read-aba");

	await (
		fixture.mirror as unknown as {
			handleRemoteDelete: (
				path: string,
				options: { baselineText?: string | null },
			) => Promise<void>;
		}
	).handleRemoteDelete(FILE_PATH, { baselineText: cleanDiskBaseline });

	assert(readCount === 1, "identity replacement is rejected before adopting a new final-read target");
	assert(fixture.deleteCalls.length === 0, "same-bytes replacement between reads is never trashed");
	assert(fixture.diskFiles.get(FILE_PATH) === cleanDiskBaseline, "between-read replacement survives");
	assert(fixture.mirror.isPreservedUnresolved(FILE_PATH), "between-read ABA is quarantined");

	fixture.doc.destroy();
}

console.log("\n--- Test 13e: failed recoverable trash keeps disk and quarantine ---");
{
	const cleanDiskBaseline = "CLEAN_DISK_TRASH_FAILURE\n";
	const fixture = makeHarness({
		initialDiskContent: cleanDiskBaseline,
		trashBehavior: "throw",
	});
	fixture.ytext.insert(0, cleanDiskBaseline);
	fixture.setAuthoritativeDeleteFingerprint("remote-delete-trash-failure");

	await (
		fixture.mirror as unknown as {
			handleRemoteDelete: (
				path: string,
				options: { baselineText?: string | null },
			) => Promise<void>;
		}
	).handleRemoteDelete(FILE_PATH, { baselineText: cleanDiskBaseline });

	assert(fixture.getTrashAttempts() === 1, "recoverable trash is attempted once");
	assert(fixture.getHardDeleteCalls() === 0, "trash failure never falls back to irreversible Vault.delete");
	assert(fixture.diskFiles.get(FILE_PATH) === cleanDiskBaseline, "trash failure preserves disk bytes");
	assert(fixture.mirror.isPreservedUnresolved(FILE_PATH), "trash failure records a durable quarantine marker");
	assert(
		fixture.mirror.getPreservedUnresolvedEntries()[0]?.reason === "remote-delete-trash-failed",
		"trash failure marker records the recoverable-delete failure reason",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 13f: successful trash resolves marker only after trash settles ---");
{
	const cleanDiskBaseline = "CLEAN_DISK_TRASH_SUCCESS\n";
	let markerPresentInsideTrash = false;
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: cleanDiskBaseline,
		onAfterTrash: () => {
			markerPresentInsideTrash = fixture.mirror.isPreservedUnresolved(FILE_PATH);
		},
	});
	fixture.ytext.insert(0, cleanDiskBaseline);
	fixture.setAuthoritativeDeleteFingerprint("remote-delete-trash-success");
	fixture.mirror.recordPreservedUnresolved(FILE_PATH, "remote-delete-missing-baseline");

	await (
		fixture.mirror as unknown as {
			handleRemoteDelete: (
				path: string,
				options: { baselineText?: string | null },
			) => Promise<void>;
		}
	).handleRemoteDelete(FILE_PATH, { baselineText: cleanDiskBaseline });

	assert(markerPresentInsideTrash, "marker remains present until recoverable trash promise settles");
	assert(fixture.deleteCalls.length === 1, "successful remote delete uses recoverable trash");
	assert(!fixture.diskFiles.has(FILE_PATH), "successful trash removes the live vault path");
	assert(!fixture.mirror.isPreservedUnresolved(FILE_PATH), "exact current tombstone clears prior marker after trash");

	fixture.doc.destroy();
}

console.log("\n--- Test 13g: failed dirty revival keeps the exact prior marker ---");

for (const ensureFileBehavior of ["throw", "replan", "blocked"] as const) {
	const baseline = "REVIVE_BASELINE\n";
	const localDirty = "LOCAL_DIRTY_TO_PRESERVE\n";
	const fixture = makeHarness({
		initialDiskContent: localDirty,
		ensureFileBehavior,
	});
	fixture.ytext.insert(0, baseline);
	fixture.setAuthoritativeDeleteFingerprint("remote-delete-revive-failure");
	fixture.mirror.recordPreservedUnresolved(FILE_PATH, "remote-delete-missing-baseline");
	const before = fixture.mirror.getPreservedUnresolvedEntries()[0];

	await (
		fixture.mirror as unknown as {
			handleRemoteDelete: (
				path: string,
				options: { baselineText?: string | null },
			) => Promise<void>;
		}
	).handleRemoteDelete(FILE_PATH, { baselineText: baseline });

	const after = fixture.mirror.getPreservedUnresolvedEntries()[0];
	assert(fixture.getEnsureFileCalls() === 1, `${ensureFileBehavior}: dirty preservation attempts one tombstone revival`);
	assert(fixture.diskFiles.get(FILE_PATH) === localDirty, `${ensureFileBehavior}: revive failure preserves local disk authority`);
	assert(fixture.mirror.isPreservedUnresolved(FILE_PATH), `${ensureFileBehavior}: revive failure keeps the path quarantined`);
	assert(
		before?.episodeId === after?.episodeId && before?.reason === after?.reason,
		`${ensureFileBehavior}: revive failure does not replace or clear the prior unresolved episode`,
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 13g2: dirty revival rejects a disk authority that changed after inspection ---");
{
	const baseline = "REVIVE_STALE_BASELINE\n";
	const firstLocalDirty = "LOCAL_DIRTY_FIRST_READ\n";
	const newerLocalDirty = "LOCAL_DIRTY_AFTER_READ\n";
	let readCount = 0;
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: firstLocalDirty,
		onRead: () => {
			readCount++;
			if (readCount === 1) fixture.diskFiles.set(FILE_PATH, newerLocalDirty);
		},
	});
	fixture.ytext.insert(0, baseline);
	fixture.setAuthoritativeDeleteFingerprint("remote-delete-stale-dirty-revive");

	await (
		fixture.mirror as unknown as {
			handleRemoteDelete: (
				path: string,
				options: { baselineText?: string | null },
			) => Promise<void>;
		}
	).handleRemoteDelete(FILE_PATH, { baselineText: baseline });

	assert(readCount === 2, "dirty preservation re-reads disk immediately before revival");
	assert(fixture.getEnsureFileCalls() === 0, "stale dirty snapshot never reaches ensureFile");
	assert(fixture.diskFiles.get(FILE_PATH) === newerLocalDirty, "newer local disk edit remains authoritative");
	assert(fixture.ytext.toString() === baseline, "stale first-read content is not revived into CRDT");
	assert(fixture.mirror.isPreservedUnresolved(FILE_PATH), "changed dirty authority is quarantined");

	fixture.doc.destroy();
}

console.log("\n--- Test 13h: exact dirty revival clears marker only after CRDT settles ---");
{
	const baseline = "REVIVE_EXACT_BASELINE\n";
	const localDirty = "LOCAL_DIRTY_EXACT_WINNER\n";
	let markerPresentDuringEnsure = false;
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: localDirty,
		onAfterEnsureFileSettle: () => {
			markerPresentDuringEnsure = fixture.mirror.isPreservedUnresolved(FILE_PATH);
		},
	});
	fixture.ytext.insert(0, baseline);
	fixture.setAuthoritativeDeleteFingerprint("remote-delete-revive-success");
	fixture.mirror.recordPreservedUnresolved(FILE_PATH, "remote-delete-missing-baseline");

	await (
		fixture.mirror as unknown as {
			handleRemoteDelete: (
				path: string,
				options: { baselineText?: string | null },
			) => Promise<void>;
		}
	).handleRemoteDelete(FILE_PATH, { baselineText: baseline });

	assert(markerPresentDuringEnsure, "marker remains present while ensureFile settles active CRDT state");
	assert(fixture.ytext.toString() === localDirty, "active Y.Text exposes the exact preserved disk bytes");
	assert(!fixture.mirror.isPreservedUnresolved(FILE_PATH), "exact active revival clears the prior marker last");
	assert(fixture.diskFiles.get(FILE_PATH) === localDirty, "exact revival leaves local disk bytes untouched");

	fixture.doc.destroy();
}

console.log("\n--- Test 13i: non-file path occupant after trash keeps quarantine ---");
{
	const cleanDiskBaseline = "CLEAN_BEFORE_FOLDER_COLLISION\n";
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: cleanDiskBaseline,
		onAfterTrash: () => {
			// Model a folder/other TAbstractFile taking the same path while the
			// recoverable trash promise is in flight.
			fixture.occupyPathWithNonFile();
		},
	});
	fixture.ytext.insert(0, cleanDiskBaseline);
	fixture.setAuthoritativeDeleteFingerprint("remote-delete-non-file-collision");
	fixture.mirror.recordPreservedUnresolved(FILE_PATH, "remote-delete-missing-baseline");

	await (
		fixture.mirror as unknown as {
			handleRemoteDelete: (
				path: string,
				options: { baselineText?: string | null },
			) => Promise<void>;
		}
	).handleRemoteDelete(FILE_PATH, { baselineText: cleanDiskBaseline });

	assert(fixture.deleteCalls.length === 1, "original file reaches recoverable trash");
	assert(fixture.hasNonFilePathOccupant(), "non-file winner remains at the path");
	assert(fixture.mirror.isPreservedUnresolved(FILE_PATH), "non-file path collision keeps quarantine");

	fixture.doc.destroy();
}

// ── Test 14: durable baseline rejects edits that predate flush startup ─────────

console.log("\n--- Test 14: durable baseline preserves a disk edit made before flush starts ---");
{
	const durableBaselineHash = await contentBaselineHash("LAST_CLEAN_BASELINE\n");
	const fixture = makeHarness({
		initialDiskContent: "LOCAL_EDIT_BEFORE_FLUSH\n",
		baselineHashProvider: () => durableBaselineHash,
	});
	fixture.ytext.insert(0, "REMOTE_CRDT\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true);

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"pre-existing local edit is rejected against the durable clean baseline",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === "LOCAL_EDIT_BEFORE_FLUSH\n",
		"provider flush cannot adopt and overwrite a dirty disk snapshot",
	);
	assert(fixture.getProcessCalls() === 0, "dirty durable-baseline mismatch never reaches atomic commit");
	assert(fixture.getModifyCalls() === 0, "dirty durable-baseline mismatch never reaches fallback modify");

	fixture.doc.destroy();
}

console.log("\n--- Test 14b: missing production baseline defers conservatively ---");
{
	const fixture = makeHarness({
		initialDiskContent: "UNCLASSIFIED_DISK\n",
		baselineHashProvider: () => null,
	});
	fixture.ytext.insert(0, "REMOTE_CRDT\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true);

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"configured production guard defers when no durable baseline exists",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === "UNCLASSIFIED_DISK\n",
		"missing baseline preserves unclassified local disk content",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 14c: clean production baseline still permits a remote write ---");
{
	const cleanDiskContent = "LAST_CLEAN_BASELINE\n";
	const durableBaselineHash = await contentBaselineHash(cleanDiskContent);
	const fixture = makeHarness({
		initialDiskContent: cleanDiskContent,
		baselineHashProvider: () => durableBaselineHash,
	});
	fixture.ytext.insert(0, "REMOTE_CRDT\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true);

	assert(result.kind === "written", "matching durable baseline permits the planned remote write");
	assert(
		fixture.diskFiles.get(FILE_PATH) === "REMOTE_CRDT\n",
		"clean production disk is updated to the remote CRDT content",
	);
	assert(fixture.getProcessCalls() === 1, "clean production update commits through Vault.process");

	fixture.doc.destroy();
}

console.log("\n--- Test 14d: unchanged equality repairs a missing durable baseline ---");
{
	const settledContent = "LOCAL_AUTOSAVE_SETTLED\n";
	let durableBaselineHash: string | null = null;
	const fixture = makeHarness({
		initialDiskContent: settledContent,
		baselineHashProvider: () => durableBaselineHash,
	});
	fixture.mirror.setDiskWriteCallback((_path, hash) => {
		durableBaselineHash = hash;
	});
	fixture.ytext.insert(0, settledContent);

	const equalityResult = await fixture.mirror.flushWrite(FILE_PATH, true);
	const expectedSettledHash = await contentBaselineHash(settledContent);
	assert(equalityResult.kind === "unchanged", "equal disk/CRDT is observed without a write");
	assert(
		durableBaselineHash === expectedSettledHash,
		"unchanged equality publishes the clean durable baseline",
	);

	fixture.ytext.delete(0, fixture.ytext.length);
	fixture.ytext.insert(0, "REMOTE_AFTER_LOCAL_AUTOSAVE\n");
	const remoteResult = await fixture.mirror.flushWrite(FILE_PATH, true);
	assert(remoteResult.kind === "written", "repaired baseline permits the next remote update");
	assert(
		fixture.diskFiles.get(FILE_PATH) === "REMOTE_AFTER_LOCAL_AUTOSAVE\n",
		"remote update reaches disk after equality settlement",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 14e: expected existing file cannot be recreated after local deletion ---");
{
	const fixture = makeHarness();
	fixture.ytext.insert(0, "REMOTE_FROM_STALE_EXISTING_PLAN\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: "DISK_SEEN_BY_PLANNER\n",
	});

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"an expected existing snapshot becoming missing is a stale plan",
	);
	assert(!fixture.diskFiles.has(FILE_PATH), "stale existing-file plan does not recreate a local deletion");

	fixture.doc.destroy();
}

console.log("\n--- Test 14f: prior baseline plus missing disk needs explicit create authority ---");
{
	const previousHash = await contentBaselineHash("PREVIOUSLY_EXISTED\n");
	const fixture = makeHarness({ baselineHashProvider: () => previousHash });
	fixture.ytext.insert(0, "ACTIVE_CRDT\n");

	const unplannedResult = await fixture.mirror.flushWrite(FILE_PATH, true);
	assert(
		unplannedResult.kind === "deferred" && unplannedResult.reason === "disk-changed-during-write",
		"missing file with a prior baseline is treated as a local deletion",
	);
	assert(!fixture.diskFiles.has(FILE_PATH), "ordinary provider flush does not resurrect the deletion");

	const authorizedResult = await fixture.mirror.flushWrite(FILE_PATH, true, {
		allowCreateIfMissing: true,
	});
	assert(authorizedResult.kind === "written" && authorizedResult.isCreate, "explicit undelete authority permits create");
	assert(fixture.diskFiles.get(FILE_PATH) === "ACTIVE_CRDT\n", "authorized create writes the active CRDT snapshot");

	fixture.doc.destroy();
}

console.log("\n--- Test 14g: semantic remote revival grants one create authority ---");
{
	const previousHash = await contentBaselineHash("DELETED_BASELINE\n");
	const fixture = makeHarness({ baselineHashProvider: () => previousHash });
	fixture.ytext.insert(0, "REVIVED_REMOTE_CONTENT\n");
	fixture.mirror.startMapObservers();
	fixture.emitMetaChanges({
		origin: fixture.fakeProvider,
		isLocal: false,
		changes: [{ kind: "revived", fileId: FILE_ID, path: FILE_PATH }],
	});

	const result = await fixture.mirror.flushWrite(FILE_PATH, true);
	assert(result.kind === "written" && result.isCreate, "semantic revival authorizes the missing-file create");
	assert(fixture.diskFiles.get(FILE_PATH) === "REVIVED_REMOTE_CONTENT\n", "revival recreates the remote file");

	clearTimers(fixture.mirror);
	fixture.doc.destroy();
}

console.log("\n--- Test 14h: expected-missing restore cannot overwrite a file that appeared ---");
{
	const appearedContent = "LOCAL_FILE_APPEARED\n";
	const previousHash = await contentBaselineHash(appearedContent);
	const fixture = makeHarness({
		initialDiskContent: appearedContent,
		baselineHashProvider: () => previousHash,
	});
	fixture.ytext.insert(0, "SNAPSHOT_RESTORE_CONTENT\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		allowCreateIfMissing: true,
	});

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"expected-missing create authority expires when a file appears",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === appearedContent,
		"restore create cannot overwrite the newly appeared local file",
	);
	assert(fixture.getProcessCalls() === 0, "expected-missing mismatch is rejected before atomic modify");

	fixture.doc.destroy();
}

console.log("\n--- Test 14i: explicit expected-missing create rejects an identical race winner ---");
{
	const plannedContent = "SAME_CONTENT_WON_CREATE_RACE\n";
	let baselineHash: string | null = null;
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		baselineHashProvider: () => baselineHash,
		onBeforeCreate: () => {
			fixture.diskFiles.set(FILE_PATH, plannedContent);
		},
	});
	fixture.mirror.setDiskWriteCallback((_path, hash) => { baselineHash = hash; });
	fixture.ytext.insert(0, plannedContent);

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		allowCreateIfMissing: true,
	});
	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"explicit expected-missing CAS rejects any appeared file, even with identical bytes",
	);
	assert(baselineHash === null, "stale restore authority never publishes the race winner as its baseline");
	assert(fixture.diskFiles.get(FILE_PATH) === plannedContent, "identical local winner remains untouched");

	fixture.doc.destroy();
}

console.log("\n--- Test 14j: different file winning the final create race is preserved ---");
{
	const localWinner = "DIFFERENT_LOCAL_CREATE\n";
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		onBeforeCreate: () => {
			fixture.diskFiles.set(FILE_PATH, localWinner);
		},
	});
	fixture.ytext.insert(0, "REMOTE_CREATE_PLAN\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		allowCreateIfMissing: true,
	});
	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"different no-clobber winner becomes an explicit stale-disk deferral",
	);
	assert(fixture.diskFiles.get(FILE_PATH) === localWinner, "different local create is never overwritten");
	assert(!fixture.mirror.isSuppressed(FILE_PATH), "failed create-race suppression is cleared immediately");

	fixture.doc.destroy();
}

console.log("\n--- Test 14k: remote create authority is consumed by an existing target ---");
{
	const existingContent = "EXISTING_TARGET\n";
	const baselineHash = await contentBaselineHash(existingContent);
	const fixture = makeHarness({
		initialDiskContent: existingContent,
		baselineHashProvider: () => baselineHash,
	});
	fixture.ytext.insert(0, existingContent);
	fixture.mirror.startMapObservers();
	fixture.emitMetaChanges({
		origin: fixture.fakeProvider,
		isLocal: false,
		changes: [{ kind: "revived", fileId: FILE_ID, path: FILE_PATH }],
	});

	const observedExisting = await fixture.mirror.flushWrite(FILE_PATH, true);
	assert(observedExisting.kind === "unchanged", "revival observes the already-existing target");
	fixture.diskFiles.delete(FILE_PATH);
	fixture.ytext.delete(0, fixture.ytext.length);
	fixture.ytext.insert(0, "LATER_REMOTE_UPDATE\n");
	const afterLocalDelete = await fixture.mirror.flushWrite(FILE_PATH, true);
	assert(
		afterLocalDelete.kind === "deferred" && afterLocalDelete.reason === "disk-changed-during-write",
		"consumed revival authority cannot recreate a later local deletion",
	);
	assert(!fixture.diskFiles.has(FILE_PATH), "later provider content does not resurrect the locally deleted target");

	clearTimers(fixture.mirror);
	fixture.doc.destroy();
}

console.log("\n--- Test 14l: post-process disk change blocks baseline settlement ---");
{
	const expectedDiskContent = "DISK_BEFORE_PROCESS\n";
	const externalAfterCommit = "EXTERNAL_AFTER_PROCESS_COMMIT\n";
	let baselinePublished = false;
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: expectedDiskContent,
		onAfterProcess: () => {
			fixture.diskFiles.set(FILE_PATH, externalAfterCommit);
		},
	});
	fixture.mirror.setDiskWriteCallback(() => { baselinePublished = true; });
	fixture.ytext.insert(0, "REMOTE_WRITE_C1\n");

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent,
	});

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"post-process disk edit prevents a written/unchanged settlement",
	);
	assert(fixture.diskFiles.get(FILE_PATH) === externalAfterCommit, "post-commit external bytes remain authoritative on disk");
	assert(!baselinePublished, "stale committed content is never published as the durable baseline");

	fixture.doc.destroy();
}

console.log("\n--- Test 14l2: post-process same-file stat ABA blocks baseline settlement ---");
{
	const expectedDiskContent = "DISK_BEFORE_SAME_FILE_ABA\n";
	const committedContent = "REMOTE_WRITE_BEFORE_SAME_FILE_ABA\n";
	let readCount = 0;
	let baselinePublished = false;
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: expectedDiskContent,
		onRead: () => {
			readCount++;
			if (readCount === 2) fixture.advanceDiskFileRevision();
		},
	});
	fixture.mirror.setDiskWriteCallback(() => { baselinePublished = true; });
	fixture.ytext.insert(0, committedContent);

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent,
	});

	assert(readCount === 2, "written settlement reaches the final disk readback boundary");
	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"same-file stat advance during written readback is not reported settled",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === committedContent,
		"same-file ABA leaves the atomically committed bytes intact for a fresh plan",
	);
	assert(!baselinePublished, "same-file post-commit ABA publishes no durable baseline");

	fixture.doc.destroy();
}

console.log("\n--- Test 14m: post-create same-bytes ABA blocks baseline settlement ---");
{
	const createdContent = "REMOTE_CREATE_C1\n";
	let baselinePublished = false;
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		onAfterCreate: () => {
			fixture.replaceDiskFileIdentity(createdContent);
		},
	});
	fixture.mirror.setDiskWriteCallback(() => { baselinePublished = true; });
	fixture.ytext.insert(0, createdContent);

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		allowCreateIfMissing: true,
	});

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"same-bytes replacement after create invalidates the create settlement",
	);
	assert(fixture.diskFiles.get(FILE_PATH) === createdContent, "replacement create bytes remain untouched");
	assert(!baselinePublished, "replaced create identity is not promoted to a clean baseline");

	fixture.doc.destroy();
}

console.log("\n--- Test 14n: unchanged same-bytes ABA blocks baseline settlement ---");
{
	const unchangedContent = "UNCHANGED_BEFORE_ABA\n";
	let readCount = 0;
	let baselinePublished = false;
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: unchangedContent,
		onRead: () => {
			readCount++;
			if (readCount === 1) fixture.replaceDiskFileIdentity(unchangedContent);
		},
	});
	fixture.mirror.setDiskWriteCallback(() => { baselinePublished = true; });
	fixture.ytext.insert(0, unchangedContent);

	const result = await fixture.mirror.flushWrite(FILE_PATH, true);

	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"unchanged observation requires the same exact file identity after hashing",
	);
	assert(!baselinePublished, "unchanged ABA cannot publish a baseline");
	assert(fixture.diskFiles.get(FILE_PATH) === unchangedContent, "unchanged replacement remains untouched");

	fixture.doc.destroy();
}

// ── Test 15: settled result is the committed snapshot, not later live CRDT ────

console.log("\n--- Test 15: CRDT C2 after commit prevents C1 settlement ---");
{
	const committedContent = "COMMITTED_C1\n";
	const laterCrdtContent = "LATER_C2\n";
	let baselinePublished = false;
	let advanceCrdtAfterCommit: (() => void) | null = null;
	const fixture = makeHarness({
		initialDiskContent: "DISK_BASELINE\n",
		onAfterProcess: () => advanceCrdtAfterCommit?.(),
	});
	advanceCrdtAfterCommit = () => {
		fixture.ytext.delete(0, fixture.ytext.length);
		fixture.ytext.insert(0, laterCrdtContent);
	};
	fixture.mirror.setDiskWriteCallback(() => { baselinePublished = true; });
	fixture.ytext.insert(0, committedContent);

	const result = await fixture.mirror.flushWrite(FILE_PATH, true);

	assert(fixture.diskFiles.get(FILE_PATH) === committedContent, "disk commit contains C1");
	assert(fixture.ytext.toJSON() === laterCrdtContent, "CRDT has already advanced to C2");
	assert(
		result.kind === "deferred" && result.reason === "disk-changed-during-write",
		"C1 is not reported settled after the exact Y.Text snapshot advances to C2",
	);
	assert(!baselinePublished, "C1 is not promoted as baseline after CRDT advances to C2");

	fixture.doc.destroy();
}

console.log("\n--- Test 15b: unchanged result also carries its verified snapshot ---");
{
	const unchangedContent = "ALREADY_SETTLED\n";
	const expectedHash = await contentBaselineHash(unchangedContent);
	const fixture = makeHarness({ initialDiskContent: unchangedContent });
	fixture.ytext.insert(0, unchangedContent);

	const result = await fixture.mirror.flushWrite(FILE_PATH, true);

	assert(
		result.kind === "unchanged"
			&& result.content === unchangedContent
			&& result.contentHash === expectedHash,
		"unchanged result reports the disk snapshot that was verified equal",
	);

	fixture.doc.destroy();
}

// ── Test 16: remote rename collision preserves both local files ─────────────

console.log("\n--- Test 16: remote rename collision preserves both local files ---");
{
	const targetPath = "notes/already-exists.md";
	const sourceContent = "SOURCE_LOCAL_WORK\n";
	const targetContent = "TARGET_LOCAL_WORK\n";
	const fixture = makeHarness({ initialDiskContent: sourceContent });
	fixture.diskFiles.set(targetPath, targetContent);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	await (fixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);

	assert(
		fixture.diskFiles.get(FILE_PATH) === sourceContent,
		"remote rename collision never deletes the source-side local work",
	);
	assert(
		fixture.diskFiles.get(targetPath) === targetContent,
		"remote rename collision never overwrites the target-side local work",
	);
	assert(
		fixture.mirror.isPreservedUnresolved(FILE_PATH) &&
			fixture.mirror.isPreservedUnresolved(targetPath),
		"both collision paths are quarantined for explicit resolution",
	);
	assert(
		debounceTimerCount(fixture.mirror) === 0 && writeQueueSize(fixture.mirror) === 0,
		"a physical source/target collision leaves no automatic write queued",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 16b: old-missing target is accepted only on exact fileId content ---");
{
	const targetPath = "notes/preexisting-target.md";
	const remoteContent = "REMOTE_FILEID_CONTENT\n";
	const independentTargetContent = "INDEPENDENT_LOCAL_TARGET\n";
	const fixture = makeHarness({ initialDiskContent: remoteContent });
	fixture.ytext.insert(0, remoteContent);
	fixture.diskFiles.delete(FILE_PATH);
	fixture.diskFiles.set(targetPath, independentTargetContent);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	await (fixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);

	assert(
		fixture.diskFiles.get(targetPath) === independentTargetContent,
		"an unrelated pre-existing target is never treated as a settled rename or overwritten",
	);
	assert(
		fixture.mirror.isPreservedUnresolved(FILE_PATH) &&
			fixture.mirror.isPreservedUnresolved(targetPath),
		"old-missing target mismatch quarantines both path namespaces",
	);
	assert(
		debounceTimerCount(fixture.mirror) === 0 && writeQueueSize(fixture.mirror) === 0,
		"target mismatch queues no blind CRDT write",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 16c: exact old-missing target settles without a blind rewrite ---");
{
	const targetPath = "notes/already-settled.md";
	const remoteContent = "EXACT_REMOTE_CONTENT\n";
	const fixture = makeHarness({ initialDiskContent: remoteContent });
	fixture.ytext.insert(0, remoteContent);
	fixture.diskFiles.delete(FILE_PATH);
	fixture.diskFiles.set(targetPath, remoteContent);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	await (fixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);

	assert(
		fixture.diskFiles.get(targetPath) === remoteContent,
		"an exact target remains unchanged",
	);
	assert(
		!fixture.mirror.isPreservedUnresolved(FILE_PATH) &&
			!fixture.mirror.isPreservedUnresolved(targetPath),
		"an exact stable fileId target is accepted as settled",
	);
	assert(
		debounceTimerCount(fixture.mirror) === 0 && writeQueueSize(fixture.mirror) === 0,
		"already-settled target does not receive a redundant write",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 16d: target appearance at rename commit preserves both sides ---");
{
	const targetPath = "notes/appears-at-commit.md";
	const sourceContent = "SOURCE_MUST_SURVIVE\n";
	const targetContent = "TARGET_APPEARED_DURING_RENAME\n";
	let fixture: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: sourceContent,
		onBeforeRename: () => {
			fixture.diskFiles.set(targetPath, targetContent);
		},
	});
	fixture.ytext.insert(0, sourceContent);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	await (fixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);

	assert(
		fixture.diskFiles.get(FILE_PATH) === sourceContent,
		"a source remains intact when the target appears at the physical rename boundary",
	);
	assert(
		fixture.diskFiles.get(targetPath) === targetContent,
		"a target appearing at commit is not clobbered",
	);
	assert(
		fixture.mirror.isPreservedUnresolved(FILE_PATH) &&
			fixture.mirror.isPreservedUnresolved(targetPath),
		"the commit-time collision quarantines both sides",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 16e: destination lock serializes concurrent create with rename ---");
{
	const targetPath = "notes/concurrent-create.md";
	const sourceContent = "REMOTE_RENAME_SOURCE\n";
	let releaseRename!: () => void;
	let reportRenameEntered!: () => void;
	const renameEntered = new Promise<void>((resolve) => { reportRenameEntered = resolve; });
	const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
	const fixture = makeHarness({
		initialDiskContent: sourceContent,
		onBeforeRename: async () => {
			reportRenameEntered();
			await renameGate;
		},
	});
	fixture.ytext.insert(0, sourceContent);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	const renamePromise = (fixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);
	await renameEntered;
	let createSettled = false;
	const concurrentCreate = fixture.mirror.flushWrite(targetPath, true, {
		allowCreateIfMissing: true,
	}).finally(() => { createSettled = true; });
	await Promise.resolve();
	await Promise.resolve();

	assert(!createSettled, "a concurrent destination create waits behind the dual-path rename lock");
	releaseRename();
	await renamePromise;
	const createResult = await concurrentCreate;

	assert(
		fixture.diskFiles.get(targetPath) === sourceContent && !fixture.diskFiles.has(FILE_PATH),
		"the physical rename wins without duplicate or overwritten content",
	);
	assert(
		createResult.kind === "deferred" && createResult.reason === "disk-changed-during-write",
		"the queued expected-missing create rechecks the destination and defers",
	);

	clearTimers(fixture.mirror);
	fixture.doc.destroy();
}

console.log("\n--- Test 16f: newer metadata intent after disk commit retires stale old-path work ---");
{
	const targetPath = "notes/first-remote-target.md";
	const newerTargetPath = "notes/newer-remote-target.md";
	const sourceContent = "SOURCE_FOR_MOVING_INTENT\n";
	let fixture: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: sourceContent,
		onAfterRename: () => {
			fixture.meta.set(FILE_ID, { path: newerTargetPath, deleted: false });
		},
	});
	fixture.ytext.insert(0, sourceContent);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });
	fixture.mirror.scheduleWrite(FILE_PATH);

	await (fixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);

	assert(
		fixture.diskFiles.get(targetPath) === sourceContent && !fixture.diskFiles.has(FILE_PATH),
		"the committed physical move is preserved when a newer metadata intent arrives",
	);
	assert(
		debounceTimerCount(fixture.mirror) === 0 && writeQueueSize(fixture.mirror) === 0,
		"stale old-path work is retired instead of recreating the source",
	);
	assert(
		fixture.mirror.isPreservedUnresolved(targetPath),
		"the intermediate physical target is quarantined for the newer intent to reconcile",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 16g: remote rename carries an unresolved episode to the new path ---");
{
	const targetPath = "notes/remote-renamed-unresolved.md";
	const sourceContent = "REMOTE_RENAME_PRESERVED_WORK\n";
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: sourceContent,
		// Obsidian emits the local vault rename event before renameFile settles.
		// Model ReconciliationController's callback so the remote handler sees an
		// already-moved target marker when it resumes.
		onAfterRename: () => {
			fixture.mirror.redirectPreservedUnresolved(FILE_PATH, targetPath);
		},
	});
	fixture.ytext.insert(0, sourceContent);
	fixture.mirror.scheduleWrite(FILE_PATH);
	fixture.mirror.recordPreservedUnresolved(
		FILE_PATH,
		"conflict-winner-flush-deferred",
	);
	const sourceEntry = fixture.mirror.getPreservedUnresolvedEntries()
		.find((entry) => entry.path === FILE_PATH);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	await (fixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);

	const targetEntry = fixture.mirror.getPreservedUnresolvedEntries()
		.find((entry) => entry.path === targetPath);
	assert(!fixture.mirror.isPreservedUnresolved(FILE_PATH), "remote rename removes the old-path marker");
	assert(
		!!sourceEntry && !!targetEntry &&
			targetEntry.episodeId === sourceEntry.episodeId &&
			targetEntry.reason === sourceEntry.reason &&
			targetEntry.firstSeenAt === sourceEntry.firstSeenAt &&
			targetEntry.lastSeenAt === sourceEntry.lastSeenAt &&
			targetEntry.localHash === sourceEntry.localHash &&
			targetEntry.knownRemoteHash === sourceEntry.knownRemoteHash,
		"remote rename preserves the complete unresolved episode at the new path",
	);
	assert(
		fixture.diskFiles.get(targetPath) === sourceContent && !fixture.diskFiles.has(FILE_PATH),
		"remote rename still commits the physical file move",
	);
	assert(
		debounceTimerCount(fixture.mirror) === 0 && writeQueueSize(fixture.mirror) === 0,
		"the moved marker retires old work and blocks target write admission",
	);
	const blocked = await fixture.mirror.flushWrite(targetPath, true);
	assert(
		blocked.kind === "blocked" && blocked.reason === "preserved-unresolved",
		"a direct post-rename target flush remains blocked",
	);
	assert(
		fixture.getProcessCalls() === 0 && fixture.getModifyCalls() === 0,
		"the blocked post-rename flush performs no disk write",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 16h: local rename carries an unresolved episode through the public redirect ---");
{
	const targetPath = "notes/local-renamed-unresolved.md";
	const sourceContent = "LOCAL_RENAME_PRESERVED_WORK\n";
	const fixture = makeHarness({ initialDiskContent: sourceContent });
	fixture.ytext.insert(0, sourceContent);
	fixture.mirror.scheduleWrite(FILE_PATH);
	fixture.mirror.recordPreservedUnresolved(
		FILE_PATH,
		"three-way-preserve-failed",
	);
	const sourceEntry = fixture.mirror.getPreservedUnresolvedEntries()
		.find((entry) => entry.path === FILE_PATH);
	await fixture.renameDiskFile(FILE_PATH, targetPath);
	const redirect = fixture.mirror.redirectPreservedUnresolved(FILE_PATH, targetPath);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	const targetEntry = fixture.mirror.getPreservedUnresolvedEntries()
		.find((entry) => entry.path === targetPath);
	assert(redirect.kind === "moved", "the public local-rename hook moves the unresolved marker");
	assert(!fixture.mirror.isPreservedUnresolved(FILE_PATH), "local rename removes the old-path marker");
	assert(
		!!sourceEntry && !!targetEntry &&
			targetEntry.episodeId === sourceEntry.episodeId &&
			targetEntry.reason === sourceEntry.reason &&
			targetEntry.firstSeenAt === sourceEntry.firstSeenAt &&
			targetEntry.lastSeenAt === sourceEntry.lastSeenAt,
		"local rename preserves the unresolved episode and timestamps",
	);
	assert(
		debounceTimerCount(fixture.mirror) === 0 && writeQueueSize(fixture.mirror) === 0,
		"local marker redirect leaves no automatic write queued",
	);
	const blocked = await fixture.mirror.flushWrite(targetPath, true);
	assert(
		blocked.kind === "blocked" && blocked.reason === "preserved-unresolved",
		"a direct flush at the locally renamed path remains blocked",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 16i: a different target episode quarantines both rename namespaces ---");
{
	const targetPath = "notes/target-owned-by-another-episode.md";
	const sourceContent = "SOURCE_EPISODE_WORK\n";
	const fixture = makeHarness({ initialDiskContent: sourceContent });
	fixture.ytext.insert(0, sourceContent);
	fixture.mirror.recordPreservedUnresolved(
		FILE_PATH,
		"conflict-winner-flush-deferred",
	);
	fixture.mirror.recordPreservedUnresolved(
		targetPath,
		"three-way-preserve-failed",
	);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	await (fixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);

	const entries = fixture.mirror.getPreservedUnresolvedEntries();
	assert(
		entries.find((entry) => entry.path === FILE_PATH)?.reason === "path-collision" &&
			entries.find((entry) => entry.path === targetPath)?.reason === "path-collision",
		"different source and target episodes become a two-path collision quarantine",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === sourceContent && !fixture.diskFiles.has(targetPath),
		"episode collision prevents the physical rename",
	);
	assert(
		debounceTimerCount(fixture.mirror) === 0 && writeQueueSize(fixture.mirror) === 0,
		"episode collision queues no target write",
	);
	const blocked = await fixture.mirror.flushWrite(targetPath, true);
	assert(
		blocked.kind === "blocked" && blocked.reason === "preserved-unresolved",
		"the target collision quarantine blocks direct create/flush",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 16j: local redirect converts different episodes to a path collision ---");
{
	const targetPath = "notes/local-target-owned-by-another-episode.md";
	const sourceContent = "LOCAL_SOURCE_EPISODE_WORK\n";
	const fixture = makeHarness({ initialDiskContent: sourceContent });
	fixture.ytext.insert(0, sourceContent);
	fixture.mirror.recordPreservedUnresolved(
		FILE_PATH,
		"conflict-winner-flush-deferred",
	);
	fixture.mirror.recordPreservedUnresolved(
		targetPath,
		"three-way-preserve-failed",
	);
	await fixture.renameDiskFile(FILE_PATH, targetPath);
	const redirect = fixture.mirror.redirectPreservedUnresolved(FILE_PATH, targetPath);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	const entries = fixture.mirror.getPreservedUnresolvedEntries();
	assert(redirect.kind === "collision", "the public local-rename hook reports an episode collision");
	assert(
		entries.find((entry) => entry.path === FILE_PATH)?.reason === "path-collision" &&
			entries.find((entry) => entry.path === targetPath)?.reason === "path-collision",
		"the public redirect quarantines both old and new namespaces",
	);
	assert(
		debounceTimerCount(fixture.mirror) === 0 && writeQueueSize(fixture.mirror) === 0,
		"local episode collision leaves no automatic write queued",
	);
	const blocked = await fixture.mirror.flushWrite(targetPath, true);
	assert(
		blocked.kind === "blocked" && blocked.reason === "preserved-unresolved",
		"local target collision remains blocked from a direct flush",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 16k: same-bytes source replacement aborts remote rename ---");
{
	const targetPath = "notes/source-aba-target.md";
	const sourceContent = "SOURCE_SAME_BYTES_ABA\n";
	let readCalls = 0;
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: sourceContent,
		onRead: () => {
			readCalls++;
			if (readCalls === 1) {
				fixture.replaceDiskFileIdentityAt(FILE_PATH, sourceContent);
			}
		},
	});
	fixture.ytext.insert(0, sourceContent);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	await (fixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);

	assert(
		fixture.diskFiles.get(FILE_PATH) === sourceContent && !fixture.diskFiles.has(targetPath),
		"a replacement source with identical bytes is not moved by an older remote rename plan",
	);
	assert(
		fixture.mirror.isPreservedUnresolved(FILE_PATH) &&
			fixture.mirror.isPreservedUnresolved(targetPath),
		"source identity ABA quarantines both rename namespaces",
	);
	assert(
		debounceTimerCount(fixture.mirror) === 0 && writeQueueSize(fixture.mirror) === 0,
		"source identity ABA queues no target rewrite",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 16l: same-bytes target replacement after rename is not settled ---");
{
	const targetPath = "notes/target-aba-after-rename.md";
	const sourceContent = "TARGET_SAME_BYTES_ABA\n";
	let fixture!: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: sourceContent,
		onAfterRename: () => {
			fixture.replaceDiskFileIdentityAt(targetPath, sourceContent);
		},
	});
	fixture.ytext.insert(0, sourceContent);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	await (fixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);

	assert(
		!fixture.diskFiles.has(FILE_PATH) && fixture.diskFiles.get(targetPath) === sourceContent,
		"the replacement target survives the completed physical move",
	);
	assert(
		fixture.mirror.isPreservedUnresolved(FILE_PATH) &&
			fixture.mirror.isPreservedUnresolved(targetPath),
		"post-rename target identity ABA is quarantined instead of accepted as settled",
	);
	assert(
		debounceTimerCount(fixture.mirror) === 0 && writeQueueSize(fixture.mirror) === 0,
		"post-rename target identity ABA queues no blind CRDT write",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 16m: only the exact in-flight remote rename event consumes its token ---");
{
	const targetPath = "notes/exact-remote-rename-event.md";
	const sourceContent = "EXACT_REMOTE_RENAME_EVENT\n";
	let fixture!: ReturnType<typeof makeHarness>;
	let exactEventConsumed = false;
	fixture = makeHarness({
		initialDiskContent: sourceContent,
		onAfterRename: () => {
			const movedFile = fixture.getDiskFileAt(targetPath);
			if (!movedFile) throw new Error("renamed target identity missing");
			exactEventConsumed = fixture.mirror.consumeRemoteRename(
				FILE_PATH,
				targetPath,
				movedFile,
			);
		},
	});
	fixture.ytext.insert(0, sourceContent);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	await (fixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);

	const movedFile = fixture.getDiskFileAt(targetPath);
	assert(exactEventConsumed, "the matching old path, new path, and TFile identity consume the token");
	assert(
		!!movedFile && !fixture.mirror.consumeRemoteRename(FILE_PATH, targetPath, movedFile),
		"the exact remote rename token is consume-once",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 16n: a missing remote event leaves no token for a later local rename ---");
{
	const targetPath = "notes/stale-token-target.md";
	const sourceContent = "REMOTE_RENAME_WITHOUT_EVENT\n";
	const fixture = makeHarness({ initialDiskContent: sourceContent });
	fixture.ytext.insert(0, sourceContent);
	fixture.meta.set(FILE_ID, { path: targetPath, deleted: false });

	await (fixture.mirror as unknown as {
		handleRemoteRename: (fileId: string, oldPath: string, newPath: string) => Promise<void>;
	}).handleRemoteRename(FILE_ID, FILE_PATH, targetPath);

	const movedFile = fixture.getDiskFileAt(targetPath);
	const unrelatedLocalFile = Object.assign(new TFile(), {
		path: targetPath,
		stat: { size: sourceContent.length },
	});
	assert(
		!!movedFile && !fixture.mirror.consumeRemoteRename(FILE_PATH, targetPath, movedFile),
		"an unobserved remote rename token is retired when renameFile settles",
	);
	assert(
		!fixture.mirror.consumeRemoteRename(
			"notes/unrelated-local-source.md",
			targetPath,
			unrelatedLocalFile,
		),
		"a later local rename into the same target is never swallowed as remote",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 17: preserved-unresolved hard-blocks a follow-up remote flush ---");
{
	const diskContent = "VISIBLE_DISK_CANDIDATE_D\n";
	const crdtContent = "COMPETING_CRDT_CANDIDATE_C\n";
	const fixture = makeHarness({ initialDiskContent: diskContent });
	fixture.ytext.insert(0, crdtContent);
	fixture.mirror.recordPreservedUnresolved(
		FILE_PATH,
		"conflict-winner-flush-deferred",
	);

	const result = await fixture.mirror.flushWrite(FILE_PATH, true);

	assert(
		result.kind === "blocked" && result.reason === "preserved-unresolved",
		"the real DiskMirror rejects the post-close/provider flush while Attention is unresolved",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === diskContent,
		"the blocked follow-up flush leaves the original disk candidate byte-for-byte intact",
	);
	assert(
		fixture.ytext.toString() === crdtContent,
		"the blocked follow-up flush leaves the competing CRDT candidate intact",
	);
	assert(
		fixture.getProcessCalls() === 0 && fixture.getModifyCalls() === 0,
		"the hard block happens before any Vault write primitive",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 17b: a conflict discovered during disk read aborts before process ---");
{
	const diskContent = "DISK_DURING_READ_D\n";
	const crdtContent = "CRDT_DURING_READ_C\n";
	let fixture: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: diskContent,
		onRead: () => {
			fixture.mirror.recordPreservedUnresolved(
				FILE_PATH,
				"conflict-winner-flush-deferred",
			);
		},
	});
	fixture.ytext.insert(0, crdtContent);

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: diskContent,
	});

	assert(
		result.kind === "blocked" && result.reason === "preserved-unresolved",
		"a marker arriving during the initial read is caught by the post-read fence",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === diskContent && fixture.ytext.toString() === crdtContent,
		"post-read blocking preserves both candidates",
	);
	assert(fixture.getProcessCalls() === 0, "post-read blocking never enters Vault.process");

	fixture.doc.destroy();
}

console.log("\n--- Test 17c: a conflict discovered at Vault.process entry aborts atomically ---");
{
	const diskContent = "DISK_AT_PROCESS_D\n";
	const crdtContent = "CRDT_AT_PROCESS_C\n";
	let fixture: ReturnType<typeof makeHarness>;
	fixture = makeHarness({
		initialDiskContent: diskContent,
		onBeforeProcess: () => {
			fixture.mirror.recordPreservedUnresolved(
				FILE_PATH,
				"conflict-winner-flush-deferred",
			);
		},
	});
	fixture.ytext.insert(0, crdtContent);

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: diskContent,
	});

	assert(
		result.kind === "blocked" && result.reason === "preserved-unresolved",
		"a marker arriving at process entry is rejected inside the atomic transform",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === diskContent && fixture.ytext.toString() === crdtContent,
		"atomic-process blocking preserves both candidates",
	);
	assert(fixture.getProcessCalls() === 1, "the process callback runs once and aborts before commit");

	fixture.doc.destroy();
}

console.log("\n--- Test 17d: caller authority is checked inside Vault.process before bytes commit ---");
{
	const diskContent = "DISK_BEFORE_AUTHORITY_RACE\n";
	const crdtContent = "CRDT_FROM_ORIGINAL_PLAN\n";
	let authorityCurrent = true;
	let baselineCalls = 0;
	const fixture = makeHarness({
		initialDiskContent: diskContent,
		onBeforeProcess: () => {
			authorityCurrent = false;
		},
	});
	fixture.mirror.setDiskWriteCallback(() => { baselineCalls++; });
	fixture.ytext.insert(0, crdtContent);

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: diskContent,
		recordBaseline: true,
		isAuthorityCurrent: () => authorityCurrent,
	} as Parameters<DiskMirror["flushWrite"]>[2]);

	assert(
		result.kind === "deferred" && result.reason === "authority-stale",
		"authority invalidation at process entry returns a bounded stale deferral",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === diskContent,
		"authority invalidation inside Vault.process returns no replacement bytes",
	);
	assert(fixture.getProcessCalls() === 1, "authority is rechecked inside the atomic callback");
	assert(baselineCalls === 0, "atomic authority rejection publishes no baseline callback");

	fixture.doc.destroy();
}

console.log("\n--- Test 17e: unchanged settlement rechecks caller authority before baseline callback ---");
{
	const settledContent = "UNCHANGED_AUTHORITY_SNAPSHOT\n";
	let authorityCurrent = true;
	let readCount = 0;
	let baselineCalls = 0;
	const fixture = makeHarness({
		initialDiskContent: settledContent,
		onRead: () => {
			readCount++;
			if (readCount === 2) authorityCurrent = false;
		},
	});
	fixture.mirror.setDiskWriteCallback(() => { baselineCalls++; });
	fixture.ytext.insert(0, settledContent);

	const result = await fixture.mirror.flushWrite(FILE_PATH, true, {
		expectedDiskContent: settledContent,
		recordBaseline: true,
		isAuthorityCurrent: () => authorityCurrent,
	} as Parameters<DiskMirror["flushWrite"]>[2]);

	assert(readCount === 2, "unchanged settlement reaches the final disk readback boundary");
	assert(
		result.kind === "deferred" && result.reason === "authority-stale",
		"authority invalidation during unchanged readback is not reported settled",
	);
	assert(baselineCalls === 0, "stale unchanged snapshot publishes no baseline callback");
	assert(
		fixture.diskFiles.get(FILE_PATH) === settledContent,
		"unchanged authority rejection leaves disk bytes untouched",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 17f: a successful create consumes remote-create authority before stale settlement ---");
{
	const createdContent = "REMOTE_CREATE_THEN_STALE\n";
	const fixture = makeHarness({
		baselineHashProvider: () => "durable-prior-baseline",
	});
	fixture.ytext.insert(0, createdContent);
	(fixture.mirror as unknown as {
		authorizeRemoteCreate(path: string): void;
	}).authorizeRemoteCreate(FILE_PATH);

	const first = await fixture.mirror.flushWrite(FILE_PATH, true, {
		isAuthorityCurrent: (phase: "before-commit" | "after-commit") =>
			phase === "before-commit",
	} as Parameters<DiskMirror["flushWrite"]>[2]);

	assert(
		first.kind === "deferred" && first.reason === "authority-stale",
		"a post-create authority change defers settlement after the file was created",
	);
	assert(
		fixture.diskFiles.get(FILE_PATH) === createdContent,
		"the stale settlement accurately reports that create already committed",
	);
	assert(
		!(fixture.mirror as unknown as {
			remoteCreateAuthorizations: Map<string, number>;
		}).remoteCreateAuthorizations.has(FILE_PATH),
		"the one-shot remote-create authorization is consumed by the committed create",
	);

	// Model a local delete after that committed-but-unsettled create. A normal
	// retry must respect the durable baseline instead of borrowing stale create
	// authority and resurrecting the path.
	fixture.diskFiles.delete(FILE_PATH);
	const retry = await fixture.mirror.flushWrite(FILE_PATH, true);
	assert(
		retry.kind === "deferred" && retry.reason === "disk-changed-during-write",
		"an ordinary retry cannot reuse the consumed create authority after local delete",
	);
	assert(
		!fixture.diskFiles.has(FILE_PATH),
		"the local delete remains intact after the ordinary retry",
	);

	fixture.doc.destroy();
}

console.log("\n--- Test 17g: raw BOM artifact create is acknowledged by exact suppression ---");
{
	const rawArtifact = "\ufeffexternal conflict\r\n";
	const fixture = makeHarness({
		initialDiskContent: rawArtifact,
		stripBomOnVaultRead: true,
	});
	const file = fixture.getCurrentDiskFile();
	if (!file) throw new Error("fixture must expose the raw artifact file");

	await fixture.mirror.suppressLocalCreate(FILE_PATH, rawArtifact);
	const suppressed = await fixture.mirror.shouldSuppressCreate(file);

	assert(
		suppressed,
		"self-create suppression fingerprints the exact adapter bytes instead of Vault.read text",
	);
	assert(!fixture.mirror.isSuppressed(FILE_PATH), "exact raw acknowledgement consumes suppression");

	fixture.doc.destroy();
}

console.log("\n--- Test 18: exact local-create suppression handles roll back without ABA ---");
{
	type SuppressionHandle = Readonly<{ path: string; token: unknown }>;
	type CancellableSuppressionContract = {
		suppressLocalCreate(path: string, content: string): Promise<SuppressionHandle | void>;
		rollbackLocalCreateSuppression?: (handle: SuppressionHandle) => boolean;
	};
	const fixture = makeHarness();
	const contract = fixture.mirror as unknown as CancellableSuppressionContract;
	const recentFingerprints = (fixture.mirror as unknown as {
		recentWriteFingerprints: Map<string, unknown>;
	}).recentWriteFingerprints;
	const first = await contract.suppressLocalCreate(FILE_PATH, "stale conflict candidate\n");
	const rollback = contract.rollbackLocalCreateSuppression;

	assert(first !== undefined, "local-create suppression returns an exact rollback handle");
	assert(typeof rollback === "function", "DiskMirror exposes exact local-create suppression rollback");
	assert(fixture.mirror.isSuppressed(FILE_PATH), "registered create suppression is initially active");
	assert(recentFingerprints.has(FILE_PATH), "registered create suppression publishes recent proof");
	if (first !== undefined && rollback) {
		assert(rollback.call(contract, first), "current suppression handle rolls back owned state");
		assert(!fixture.mirror.isSuppressed(FILE_PATH), "rollback removes active suppression residue");
		assert(!recentFingerprints.has(FILE_PATH), "rollback removes recent fingerprint residue");

		const older = await contract.suppressLocalCreate(FILE_PATH, "older candidate\n");
		const newer = await contract.suppressLocalCreate(FILE_PATH, "newer candidate\n");
		assert(older !== undefined && newer !== undefined, "same-path replacements each return handles");
		if (older !== undefined && newer !== undefined) {
			assert(
				!rollback.call(contract, older),
				"an older handle cannot erase a newer same-path suppression",
			);
			assert(fixture.mirror.isSuppressed(FILE_PATH), "newer suppression remains active after old rollback");
			assert(recentFingerprints.has(FILE_PATH), "newer recent proof remains after old rollback");
			assert(rollback.call(contract, newer), "newer exact handle can clean up its own state");
		}
	}

	fixture.doc.destroy();
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
