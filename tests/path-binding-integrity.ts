import * as Y from "yjs";
import { strict as nodeAssert } from "node:assert";
import {
	evaluatePathBindingIntegrity,
	type PathBindingIntegrityStatus,
} from "../src/sync/pathBindingIntegrity";
import {
	createNestedActiveMeta,
	getMetaPath,
	isFileMetaDeletedValue,
} from "../src/sync/fileMeta";
import {
	VaultSync,
	type EnsureFileResult,
} from "../src/sync/vaultSync";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
	if (actual === expected) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}\n        expected=${String(expected)}\n        actual=${String(actual)}`);
	failed++;
}

function assertDeepEq(actual: unknown, expected: unknown, msg: string): void {
	try {
		nodeAssert.deepEqual(actual, expected);
		console.log(`  PASS  ${msg}`);
		passed++;
	} catch (err) {
		const detail = err instanceof Error ? err.message.split("\n", 1)[0] : String(err);
		const describe = (value: unknown): string => {
			if (value instanceof Y.Text) return `Y.Text(${JSON.stringify(value.toString())})`;
			try {
				return JSON.stringify(value);
			} catch {
				return Object.prototype.toString.call(value);
			}
		};
		console.error(
			`  FAIL  ${msg}\n`
			+ `        ${detail}\n`
			+ `        expected=${describe(expected)}\n`
			+ `        actual=${describe(actual)}`,
		);
		failed++;
	}
}

type IntegritySnapshot = Readonly<{
	activeIds: readonly string[];
	pathToId: readonly [string, string][];
	idToText: readonly [string, unknown][];
	pathIndex: readonly [string, string][];
	meta: readonly [string, unknown][];
	tombstones: readonly string[];
	pendingRenames: readonly string[];
	pendingRenameTargets: readonly string[];
	flightEventCount: number;
	flightEvents: readonly unknown[];
}>;

type VaultSyncFixtureState = {
	_pathIndex: Map<string, string>;
	_renameBatch: Map<string, string>;
	_renameBatchNewToOld: Map<string, string>;
	_renameTimer: ReturnType<typeof setTimeout> | null;
	_testFlightEvents: unknown[];
};

type IntegrityEnsureOptions = {
	reviveTombstone?: boolean;
	reviveReason?: string;
	opId?: string;
	canCreate?: () => boolean;
};

function canonicalMetaValue(value: unknown): unknown {
	if (value instanceof Y.Map) return value.toJSON();
	if (value instanceof Y.Text) return { kind: "Y.Text", content: value.toString() };
	if (value === undefined) return null;
	return JSON.parse(JSON.stringify(value));
}

function snapshotIntegrity(vs: VaultSync, path: string): IntegritySnapshot {
	const normalizedPath = path.replace(/\\/g, "/");
	const activeIds = vs.getActiveFileIdsForPath(normalizedPath).slice().sort();
	const state = vs as unknown as VaultSyncFixtureState;
	const pathToId = [...vs.pathToId.entries()]
		.sort(([left], [right]) => left.localeCompare(right));
	const idToText = [...(vs.idToText as unknown as Y.Map<unknown>).entries()]
		.map(([fileId, value]) => [fileId, canonicalMetaValue(value)] as [string, unknown])
		.sort(([left], [right]) => left.localeCompare(right));
	const pathIndex = [...state._pathIndex.entries()]
		.sort(([left], [right]) => left.localeCompare(right));
	const meta = [...vs.meta.entries()]
		.map(([fileId, value]) => [fileId, canonicalMetaValue(value)] as [string, unknown])
		.sort(([left], [right]) => left.localeCompare(right));
	const tombstones = [...vs.meta.entries()]
		.filter(([, value]) => (
			getMetaPath(value)?.replace(/\\/g, "/") === normalizedPath
			&& isFileMetaDeletedValue(value)
		))
		.map(([fileId]) => fileId)
		.sort();
	const pendingRenames = [...state._renameBatch.entries()]
		.map(([oldPath, newPath]) => `${oldPath}->${newPath}`)
		.sort();
	const pendingRenameTargets = [...state._renameBatchNewToOld.entries()]
		.map(([newPath, oldPath]) => `${newPath}<-${oldPath}`)
		.sort();
	return {
		activeIds,
		pathToId,
		idToText,
		pathIndex,
		meta,
		tombstones,
		pendingRenames,
		pendingRenameTargets,
		flightEventCount: state._testFlightEvents.length,
		flightEvents: state._testFlightEvents.map(canonicalMetaValue),
	};
}

function ensureFileForIntegrity(
	vs: VaultSync,
	path: string,
	content: string,
	options?: IntegrityEnsureOptions,
): EnsureFileResult {
	return vs.ensureFile(path, content, "TestDevice", options) as unknown as EnsureFileResult;
}

function summarizeEnsureResult(result: unknown, expectedYText?: Y.Text): unknown {
	if (result === null) return null;
	if (result instanceof Y.Text) {
		return { legacyKind: "Y.Text", content: result.toString() };
	}
	if (!result || typeof result !== "object") return result;
	const record = result as Record<string, unknown>;
	if (record.kind === "existing" || record.kind === "created") {
		return {
			kind: record.kind,
			fileId: record.fileId,
			ytextMatchesExpected: expectedYText === undefined
				? record.ytext instanceof Y.Text
				: record.ytext === expectedYText,
		};
	}
	return result;
}

function addActiveFile(
	vs: VaultSync,
	fileId: string,
	path: string,
	content: string,
): Y.Text {
	const ytext = new Y.Text();
	ytext.insert(0, content);
	vs.idToText.set(fileId, ytext);
	vs.meta.set(fileId, createNestedActiveMeta(path, 10, "ProviderDevice"));
	return ytext;
}

function addTombstone(vs: VaultSync, fileId: string, path: string): void {
	const tombstone = createNestedActiveMeta(path, 10, "ProviderDevice");
	tombstone.delete("mtime");
	tombstone.set("deletedAt", 20);
	vs.meta.set(fileId, tombstone);
}

function stopRenameTimer(vs: VaultSync): void {
	const state = vs as unknown as VaultSyncFixtureState;
	if (state._renameTimer) clearTimeout(state._renameTimer);
	state._renameTimer = null;
}

function useProductionLikePathNormalization(vs: VaultSync): void {
	(vs as unknown as { normPath: (path: string) => string }).normPath = (path: string) => (
		path.replace(/\\/g, "/")
	);
}

function makeVaultSync(): VaultSync {
	const vs = Object.create(VaultSync.prototype) as VaultSync & Record<string, unknown>;
	const flightEvents: unknown[] = [];
	vs.ydoc = new Y.Doc();
	vs.pathToId = vs.ydoc.getMap("pathToId");
	vs.idToText = vs.ydoc.getMap("idToText");
	vs.meta = vs.ydoc.getMap("meta");
	vs.sys = vs.ydoc.getMap("sys");
	vs.pathToBlob = vs.ydoc.getMap("pathToBlob");
	vs.blobMeta = vs.ydoc.getMap("blobMeta");
	vs.blobTombstones = vs.ydoc.getMap("blobTombstones");
	vs._textToFileId = new WeakMap();
	vs._pathIndex = new Map();
	vs._deletedPathIndex = new Set();
	vs._activePathCollisions = new Map();
	vs._pathIndexesDirty = true;
	vs._renameBatch = new Map();
	vs._renameBatchNewToOld = new Map();
	vs._renameTimer = null;
	vs._onRenameBatchFlushed = null;
	vs.sys.set("schemaVersion", 3);
	vs._eventRing = [];
	vs.debug = false;
	vs.trace = undefined;
	vs.onFlightPathEvent = (event: unknown) => flightEvents.push(event);
	vs._testFlightEvents = flightEvents;
	vs._device = "TestDevice";
	return vs as VaultSync;
}

console.log("\n--- VaultSync ensureFile integrity boundary: collision is typed and side-effect free ---");
{
	const path = "Integrity/collision.md";
	const vs = makeVaultSync();
	addActiveFile(vs, "id-a", path, "A");
	addActiveFile(vs, "id-b", path, "B");
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "disk");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(summarizeEnsureResult(result), { kind: "blocked", reason: "collision" }, "collision has an exact typed result");
	assertDeepEq(after, before, "collision leaves the complete integrity snapshot unchanged");
}

console.log("\n--- VaultSync ensureFile integrity boundary: persisted paths are canonicalized ---");
{
	const canonicalPath = "Integrity/legacy-active.md";
	const vs = makeVaultSync();
	useProductionLikePathNormalization(vs);
	const existingText = addActiveFile(
		vs,
		"legacy-active",
		"Integrity\\legacy-active.md",
		"provider",
	);
	const before = snapshotIntegrity(vs, canonicalPath);

	const result = ensureFileForIntegrity(vs, canonicalPath, "disk");
	const after = snapshotIntegrity(vs, canonicalPath);

	assertDeepEq(
		summarizeEnsureResult(result, existingText),
		{ kind: "existing", fileId: "legacy-active", ytextMatchesExpected: true },
		"noncanonical active metadata resolves to its existing identity",
	);
	assertDeepEq(after, before, "canonical lookup does not create a duplicate identity");
}

console.log("\n--- VaultSync ensureFile integrity boundary: schema v1 pathToId is authoritative ---");
{
	const path = "Integrity/schema-v1-existing.md";
	const vs = makeVaultSync();
	vs.sys.set("schemaVersion", 1);
	const existingText = new Y.Text();
	existingText.insert(0, "legacy provider");
	vs.pathToId.set(path, "legacy-id");
	vs.idToText.set("legacy-id", existingText);
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "duplicate seed");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(
		summarizeEnsureResult(result, existingText),
		{ kind: "existing", fileId: "legacy-id", ytextMatchesExpected: true },
		"schema v1 resolves the canonical pathToId identity without metadata",
	);
	assertDeepEq(after, before, "schema v1 lookup leaves the full CRDT and event snapshot unchanged");
}

console.log("\n--- VaultSync ensureFile integrity boundary: schema v1 falls back to healthy active metadata ---");
{
	const path = "Integrity/schema-v1-meta-only.md";
	const vs = makeVaultSync();
	vs.sys.set("schemaVersion", 1);
	useProductionLikePathNormalization(vs);
	const existingText = addActiveFile(
		vs,
		"legacy-meta-only-id",
		"Integrity\\schema-v1-meta-only.md",
		"legacy metadata authority",
	);
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "must-not-seed");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(
		summarizeEnsureResult(result, existingText),
		{ kind: "existing", fileId: "legacy-meta-only-id", ytextMatchesExpected: true },
		"schema v1 metadata fallback returns the exact existing Y.Text identity",
	);
	assertDeepEq(after, before, "schema v1 metadata fallback leaves the full CRDT and event snapshot unchanged");
}

console.log("\n--- VaultSync ensureFile integrity boundary: schema v1 metadata fallback blocks collisions ---");
{
	const path = "Integrity/schema-v1-meta-collision.md";
	const vs = makeVaultSync();
	vs.sys.set("schemaVersion", 1);
	addActiveFile(vs, "legacy-meta-collision-a", path, "A");
	addActiveFile(vs, "legacy-meta-collision-b", path, "B");
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "must-not-seed");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(
		summarizeEnsureResult(result),
		{ kind: "blocked", reason: "collision" },
		"schema v1 metadata fallback preserves a complete active-path collision",
	);
	assertDeepEq(after, before, "schema v1 metadata collision refusal leaves the full CRDT and event snapshot unchanged");
}

console.log("\n--- VaultSync ensureFile integrity boundary: schema v1 metadata fallback blocks orphans ---");
{
	const path = "Integrity/schema-v1-meta-orphan.md";
	const vs = makeVaultSync();
	vs.sys.set("schemaVersion", 1);
	vs.meta.set("legacy-meta-orphan-id", createNestedActiveMeta(path, 10, "ProviderDevice"));
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "must-not-seed");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(
		summarizeEnsureResult(result),
		{ kind: "blocked", reason: "orphan" },
		"schema v1 metadata fallback preserves an orphan for repair",
	);
	assertDeepEq(after, before, "schema v1 metadata orphan refusal leaves the full CRDT and event snapshot unchanged");
}

console.log("\n--- VaultSync ensureFile integrity boundary: schema v1 ignores conflicting active metadata ---");
{
	const path = "Integrity/schema-v1-cross-index.md";
	const vs = makeVaultSync();
	vs.sys.set("schemaVersion", 1);
	const authoritativeText = new Y.Text();
	authoritativeText.insert(0, "legacy authority");
	vs.pathToId.set(path, "legacy-authority-id");
	vs.idToText.set("legacy-authority-id", authoritativeText);
	addActiveFile(vs, "stale-metadata-id", path, "stale metadata");
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "must-not-seed");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(
		summarizeEnsureResult(result, authoritativeText),
		{ kind: "existing", fileId: "legacy-authority-id", ytextMatchesExpected: true },
		"schema v1 ignores conflicting active metadata and returns pathToId authority",
	);
	assertDeepEq(after, before, "schema v1 cross-index lookup leaves every identity and event unchanged");
}

console.log("\n--- VaultSync ensureFile integrity boundary: schema v2+ ignores stale pathToId ---");
{
	const path = "Integrity/schema-v2-cross-index.md";
	const vs = makeVaultSync();
	const authoritativeText = addActiveFile(vs, "metadata-authority-id", path, "metadata authority");
	const staleText = new Y.Text();
	staleText.insert(0, "stale legacy map");
	vs.pathToId.set(path, "stale-path-map-id");
	vs.idToText.set("stale-path-map-id", staleText);
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "must-not-seed");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(
		summarizeEnsureResult(result, authoritativeText),
		{ kind: "existing", fileId: "metadata-authority-id", ytextMatchesExpected: true },
		"schema v2+ ignores stale pathToId and returns active metadata authority",
	);
	assertDeepEq(after, before, "schema v2+ cross-index lookup leaves every identity and event unchanged");
}

console.log("\n--- VaultSync ensureFile integrity boundary: schema v1 missing text is a blocked orphan ---");
{
	const path = "Integrity/schema-v1-orphan.md";
	const vs = makeVaultSync();
	vs.sys.set("schemaVersion", 1);
	vs.pathToId.set(path, "legacy-orphan-id");
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "replacement seed");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(
		summarizeEnsureResult(result),
		{ kind: "blocked", reason: "orphan" },
		"schema v1 blocks a canonical pathToId whose Y.Text target is missing",
	);
	assertDeepEq(after, before, "schema v1 orphan refusal leaves the full CRDT and event snapshot unchanged");
}

console.log("\n--- VaultSync ensureFile integrity boundary: malformed idToText is a blocked orphan ---");
{
	const path = "Integrity/malformed-text.md";
	const vs = makeVaultSync();
	vs.meta.set("malformed-id", createNestedActiveMeta(path, 10, "ProviderDevice"));
	(vs.idToText as unknown as Y.Map<unknown>).set("malformed-id", "not-a-y-text");
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "replacement seed");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(
		summarizeEnsureResult(result),
		{ kind: "blocked", reason: "orphan" },
		"a truthy non-Y.Text value is classified as an orphan instead of a healthy identity",
	);
	assertDeepEq(after, before, "malformed idToText refusal leaves the full CRDT and event snapshot unchanged");
}

console.log("\n--- VaultSync ensureFile integrity boundary: persisted tombstones are canonicalized ---");
{
	const canonicalPath = "Integrity/legacy-tombstone.md";
	const vs = makeVaultSync();
	useProductionLikePathNormalization(vs);
	addTombstone(vs, "legacy-tombstone", "Integrity\\legacy-tombstone.md");
	const before = snapshotIntegrity(vs, canonicalPath);

	const result = ensureFileForIntegrity(vs, canonicalPath, "disk");
	const after = snapshotIntegrity(vs, canonicalPath);

	assertDeepEq(
		summarizeEnsureResult(result),
		{ kind: "blocked", reason: "tombstone" },
		"noncanonical tombstone blocks canonical creation",
	);
	assertDeepEq(after, before, "canonical tombstone refusal leaves metadata unchanged");
}

console.log("\n--- VaultSync ensureFile integrity boundary: orphan metadata is preserved for repair ---");
{
	const path = "Integrity/orphan.md";
	const vs = makeVaultSync();
	vs.meta.set("orphan-id", createNestedActiveMeta(path, 10, "ProviderDevice"));
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "disk");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(summarizeEnsureResult(result), { kind: "blocked", reason: "orphan" }, "orphan has an exact typed result");
	assertDeepEq(after, before, "orphan refusal does not clean or recreate metadata");
}

console.log("\n--- VaultSync ensureFile integrity boundary: hard tombstone is side-effect free ---");
{
	const path = "Integrity/tombstone.md";
	const vs = makeVaultSync();
	addTombstone(vs, "deleted-id", path);
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "disk");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(summarizeEnsureResult(result), { kind: "blocked", reason: "tombstone" }, "hard tombstone has an exact typed result");
	assertDeepEq(after, before, "hard tombstone refusal preserves metadata and events");
}

console.log("\n--- VaultSync ensureFile integrity boundary: create policy refusal is side-effect free ---");
{
	const path = "Integrity/policy.md";
	const vs = makeVaultSync();
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "disk", {
		canCreate: () => false,
	});
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(summarizeEnsureResult(result), { kind: "blocked", reason: "policy" }, "create policy has an exact typed refusal");
	assertDeepEq(after, before, "create policy refusal leaves the complete snapshot unchanged");
}

console.log("\n--- VaultSync ensureFile integrity boundary: collision blocks pending rename and revive ---");
{
	const path = "Integrity/pending-target.md";
	const oldPath = "Integrity/pending-source.md";
	const vs = makeVaultSync();
	addActiveFile(vs, "source-id", oldPath, "source");
	addActiveFile(vs, "target-a", path, "A");
	addActiveFile(vs, "target-b", path, "B");
	addTombstone(vs, "target-deleted", path);
	vs.queueRename(oldPath, path);
	stopRenameTimer(vs);
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "disk", {
		reviveTombstone: true,
		reviveReason: "integrity-test",
	});
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(summarizeEnsureResult(result), { kind: "blocked", reason: "collision" }, "pending-rename collision stays typed as collision");
	assertDeepEq(after, before, "collision consumes neither rename token nor tombstone");
}

console.log("\n--- VaultSync ensureFile integrity boundary: healthy pending rename promotes exactly once ---");
{
	const oldPath = "Integrity/healthy-rename-source.md";
	const path = "Integrity/healthy-rename-target.md";
	const vs = makeVaultSync();
	const sourceText = addActiveFile(vs, "healthy-source-id", oldPath, "source");
	addTombstone(vs, "stale-target-id", path);
	vs.queueRename(oldPath, path);
	stopRenameTimer(vs);

	const result = ensureFileForIntegrity(vs, path, "must-not-seed");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(summarizeEnsureResult(result, sourceText), {
		kind: "existing",
		fileId: "healthy-source-id",
		ytextMatchesExpected: true,
	}, "healthy pending rename returns the promoted source identity");
	assertDeepEq(vs.getActiveFileIdsForPath(oldPath), [], "healthy pending rename removes the source path binding");
	assertDeepEq(after.activeIds, ["healthy-source-id"], "healthy pending rename installs one target identity");
	assertDeepEq(after.idToText, [["healthy-source-id", { kind: "Y.Text", content: "source" }]], "healthy pending rename preserves the exact Y.Text identity content");
	assertDeepEq(after.tombstones, [], "healthy pending rename clears the stale target tombstone");
	assertDeepEq(after.pendingRenames, [], "healthy pending rename consumes the forward token");
	assertDeepEq(after.pendingRenameTargets, [], "healthy pending rename consumes the reverse token");
	assertDeepEq(after.flightEvents, [{
		priority: "important",
		kind: "crdt.file.renamed",
		severity: "info",
		scope: "file",
		source: "vaultSync",
		layer: "crdt",
		path,
		fileId: "healthy-source-id",
		data: { batchSize: 1 },
	}], "healthy pending rename emits exactly one rename event and no create or revive event");
}

console.log("\n--- VaultSync ensureFile integrity boundary: collided rename source is not promoted ---");
{
	const oldPath = "Integrity/collided-rename-source.md";
	const path = "Integrity/collided-rename-target.md";
	const vs = makeVaultSync();
	addActiveFile(vs, "source-a", oldPath, "A");
	addActiveFile(vs, "source-b", oldPath, "B");
	vs.queueRename(oldPath, path);
	stopRenameTimer(vs);
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "disk");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(
		summarizeEnsureResult(result),
		{ kind: "blocked", reason: "collision" },
		"pending rename refuses a collided source",
	);
	assertDeepEq(after, before, "collided rename source preserves metadata, token, and events");
}

console.log("\n--- VaultSync ensureFile integrity boundary: missing rename source is deferred ---");
{
	const oldPath = "Integrity/missing-rename-source.md";
	const path = "Integrity/missing-rename-target.md";
	const vs = makeVaultSync();
	vs.queueRename(oldPath, path);
	stopRenameTimer(vs);
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "disk");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(
		summarizeEnsureResult(result),
		{ kind: "replan", reason: "active-set-changed" },
		"pending rename defers when its source identity is absent",
	);
	assertDeepEq(after, before, "missing rename source preserves metadata, token, and events");
}

console.log("\n--- VaultSync ensureFile integrity boundary: provider creation wins final recheck ---");
{
	const path = "Integrity/provider-race.md";
	const vs = makeVaultSync();
	let providerCreated = false;

	const result = ensureFileForIntegrity(vs, path, "local", {
		canCreate: () => {
			providerCreated = true;
			vs.ydoc.transact(() => {
				addActiveFile(vs, "provider-id", path, "provider");
			}, { kind: "provider-race-test" });
			return true;
		},
	});
	const after = snapshotIntegrity(vs, path);

	assert(providerCreated, "provider creation interleaves after policy evaluation");
	assertDeepEq(summarizeEnsureResult(result), { kind: "replan", reason: "active-set-changed" }, "provider winner returns typed replan");
	assertDeepEq(after, {
		activeIds: ["provider-id"],
		pathToId: [],
		idToText: [["provider-id", { kind: "Y.Text", content: "provider" }]],
		pathIndex: [[path, "provider-id"]],
		meta: [["provider-id", {
			path,
			mtime: 10,
			device: "ProviderDevice",
		}]],
		tombstones: [],
		pendingRenames: [],
		pendingRenameTargets: [],
		flightEventCount: 0,
		flightEvents: [],
	}, "provider winner is the only committed identity and emits no local creation event");
}

console.log("\n--- VaultSync ensureFile integrity boundary: healthy identity is returned unchanged ---");
{
	const path = "Integrity/existing.md";
	const vs = makeVaultSync();
	const ytext = addActiveFile(vs, "existing-id", path, "existing");
	addTombstone(vs, "stale-deleted-id", path);
	const before = snapshotIntegrity(vs, path);

	const result = ensureFileForIntegrity(vs, path, "ignored");
	const after = snapshotIntegrity(vs, path);

	assertDeepEq(summarizeEnsureResult(result, ytext), {
		kind: "existing",
		fileId: "existing-id",
		ytextMatchesExpected: true,
	}, "healthy identity has an exact existing result");
	assertDeepEq(after, before, "healthy identity lookup does not clear stale tombstones or emit events");
}

console.log("\n--- Path binding integrity: pure duplicate-active-path classification ---");
{
	const result = evaluatePathBindingIntegrity({
		path: "Folder/note.md",
		activeFileIdsForPath: ["id-a", "id-b"],
		fileId: "id-a",
		renameEvidence: "none",
	});
	assertEq<PathBindingIntegrityStatus>(
		result.status,
		"duplicate-active-path",
		"multiple active fileIds for one path are not ok",
	);
	assert(result.shouldBlockCrdtFlush, "duplicate active path blocks CRDT flush");
}

console.log("\n--- Path binding integrity: pure no-evidence structural rename classification ---");
{
	const result = evaluatePathBindingIntegrity({
		path: "Old/note.md",
		candidatePath: "New/note.md",
		activeFileIdsForPath: ["id-a"],
		fileId: "id-a",
		diskHash: "same",
		crdtHash: "same",
		baselineHash: null,
		renameEvidence: "none",
	});
	assertEq<PathBindingIntegrityStatus>(
		result.status,
		"ambiguous-structural-rename",
		"same content and basename are ambiguous without rename evidence",
	);
	assert(result.shouldPreserve, "ambiguous structural rename preserves instead of applying");
}

console.log("\n--- Path binding integrity: missing baseline with divergent content is high risk ---");
{
	const result = evaluatePathBindingIntegrity({
		path: "Old/note.md",
		candidatePath: "New/note.md",
		activeFileIdsForPath: ["id-a"],
		fileId: "id-a",
		diskHash: "disk-content",
		crdtHash: "crdt-content",
		baselineHash: null,
		renameEvidence: "none",
	});
	assertEq<PathBindingIntegrityStatus>(
		result.status,
		"missing-baseline-risk",
		"divergent content without a baseline is not hidden by ambiguous rename classification",
	);
	assert(result.shouldPreserve, "missing baseline risk preserves instead of applying");
}

console.log("\n--- Path binding integrity: explicit rename evidence remains ok ---");
{
	const result = evaluatePathBindingIntegrity({
		path: "Old/note.md",
		candidatePath: "New/note.md",
		activeFileIdsForPath: ["id-a"],
		fileId: "id-a",
		diskHash: "same",
		crdtHash: "same",
		baselineHash: null,
		renameEvidence: "explicit-rename",
	});
	assertEq<PathBindingIntegrityStatus>(result.status, "ok", "explicit rename evidence allows path movement");
	assert(!result.shouldBlockCrdtFlush, "ok binding does not block CRDT flush");
}

console.log("\n--- VaultSync path index: duplicate active path has no silent winner ---");
{
	const vs = makeVaultSync();
	const textA = new Y.Text();
	const textB = new Y.Text();
	textA.insert(0, "A");
	textB.insert(0, "B");
	vs.idToText.set("id-a", textA);
	vs.idToText.set("id-b", textB);
	vs.meta.set("id-a", createNestedActiveMeta("Shared/path.md", 10, "A"));
	vs.meta.set("id-b", createNestedActiveMeta("Shared/path.md", 20, "B"));

	assertEq(vs.getFileId("Shared/path.md"), undefined, "collided path is not mapped to newest fileId");
	assertEq(vs.getTextForPath("Shared/path.md"), null, "collided path cannot return arbitrary Y.Text");
	assertEq(vs.getActiveFileIdsForPath("Shared/path.md").join(","), "id-a,id-b", "collision exposes both fileIds");

	const integrity = vs.runIntegrityChecks();
	assertEq(integrity.duplicateActivePaths, 1, "integrity reports duplicate active path");
	assertEq(integrity.orphansCleaned, 0, "collided active fileIds are preserved, not garbage-collected");
}

console.log("\n--- VaultSync reconcile: duplicate active path is not seeded as a new file ---");
{
	const vs = makeVaultSync();
	const textA = new Y.Text();
	const textB = new Y.Text();
	textA.insert(0, "A");
	textB.insert(0, "B");
	vs.idToText.set("id-a", textA);
	vs.idToText.set("id-b", textB);
	vs.meta.set("id-a", createNestedActiveMeta("Shared/path.md", 10, "A"));
	vs.meta.set("id-b", createNestedActiveMeta("Shared/path.md", 20, "B"));

	const result = vs.reconcileVault(
		new Map([["Shared/path.md", "disk"]]),
		new Set(["Shared/path.md"]),
		"authoritative",
		"TestDevice",
	);

	assertEq(result.seededToCrdt.length, 0, "collided disk path is not seeded");
	assertEq(result.pathBindingConflicts[0], "Shared/path.md", "collision is reported in reconcile result");
	assertEq(vs.idToText.size, 2, "no third fileId is created for the collided path");
	assertEq(vs.getActiveFileIdsForPath("Shared/path.md").join(","), "id-a,id-b", "original collided ids are preserved");
}

console.log("\n--- VaultSync reconcile: excluded CRDT paths are not restored to disk ---");
{
	const vs = makeVaultSync();
	const hiddenText = new Y.Text();
	hiddenText.insert(0, "hidden");
	const visibleText = new Y.Text();
	visibleText.insert(0, "visible");
	vs.idToText.set("hidden", hiddenText);
	vs.idToText.set("visible", visibleText);
	vs.meta.set("hidden", createNestedActiveMeta(".obsidian-mobile/plugins/example/README.md", 10, "A"));
	vs.meta.set("visible", createNestedActiveMeta("notes/visible.md", 10, "A"));

	const result = vs.reconcileVault(
		new Map(),
		new Set(),
		"authoritative",
		"TestDevice",
		undefined,
		(path) => !path.split("/").some((part) => part.startsWith(".")),
	);

	assertEq(result.createdOnDisk.join(","), "notes/visible.md", "excluded CRDT path is not scheduled for disk creation");
	assertEq(vs.getTextForPath(".obsidian-mobile/plugins/example/README.md")?.toString(), "hidden", "excluded CRDT data is retained without writing it");
}

console.log("\n--- VaultSync cleanup: intrinsic exclusions tombstone remote entries only ---");
{
	const vs = makeVaultSync();
	const hiddenText = new Y.Text();
	hiddenText.insert(0, "plugin documentation");
	const visibleText = new Y.Text();
	visibleText.insert(0, "keep this note");
	vs.idToText.set("hidden", hiddenText);
	vs.idToText.set("visible", visibleText);
	vs.meta.set("hidden", createNestedActiveMeta(".obsidian-mobile/plugins/example/README.md", 10, "A"));
	vs.meta.set("visible", createNestedActiveMeta("notes/keep.md", 10, "A"));
	vs.pathToBlob.set("tools/node_modules/cache.bin", { hash: "bad", size: 1 });
	vs.pathToBlob.set("attachments/keep.png", { hash: "good", size: 2 });

	const cleanup = vs.tombstoneIntrinsicExcludedEntries(
		(path) => path.startsWith(".obsidian-mobile/"),
		(path) => path.includes("/node_modules/"),
		"TestDevice",
	);

	assertEq(cleanup.markdownPaths.join(","), ".obsidian-mobile/plugins/example/README.md", "intrinsic markdown path is selected for remote tombstoning");
	assertEq(cleanup.blobPaths.join(","), "tools/node_modules/cache.bin", "intrinsic blob path is selected for remote tombstoning");
	assert(vs.isMarkdownTombstoned(".obsidian-mobile/plugins/example/README.md"), "intrinsic markdown path is tombstoned");
	assertEq(vs.getTextForPath(".obsidian-mobile/plugins/example/README.md"), null, "tombstoned markdown no longer has an active remote path");
	assertEq(vs.idToText.get("hidden")?.toString(), "plugin documentation", "tombstone retains CRDT history to block stale resurrection");
	assertEq(vs.getTextForPath("notes/keep.md")?.toString(), "keep this note", "ordinary markdown is retained");
	assert(!vs.pathToBlob.has("tools/node_modules/cache.bin"), "intrinsic blob ref is removed from the remote path map");
	assert(vs.isBlobTombstoned("tools/node_modules/cache.bin"), "intrinsic blob path is tombstoned");
	assert(vs.pathToBlob.has("attachments/keep.png"), "ordinary blob ref is retained");
}

console.log(`\npath-binding-integrity: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
