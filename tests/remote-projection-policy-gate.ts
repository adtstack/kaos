import assert from "node:assert/strict";
import { KAOS_EXCLUDE_FILE_PATH } from "../src/sync/exclude";
import {
	RemoteProjectionPolicyGate,
} from "../src/runtime/remoteProjectionPolicyGate";
import {
	KAOS_EXCLUDE_FILE_MAX_CHARS,
	readKaosExcludeFileFromCrdt,
} from "../src/runtime/excludeFile";
import { VaultSync } from "../src/sync/vaultSync";

console.log("\n--- Remote projection policy gate ---");

{
	const gate = new RemoteProjectionPolicyGate();

	assert.equal(
		gate.isRemoteProjectionAllowed("JOURNALS/PRIVATE/secret.md"),
		false,
		"ordinary remote projection starts closed",
	);
	assert.equal(
		gate.isRemoteProjectionAllowed(KAOS_EXCLUDE_FILE_PATH),
		true,
		"the shared control document is always a bootstrap exception",
	);

	gate.close(3);
	assert.equal(gate.open(2), false, "an older provider generation cannot open the gate");
	assert.equal(
		gate.isRemoteProjectionAllowed("notes/ordinary.md"),
		false,
		"stale open leaves ordinary projection closed",
	);
	assert.equal(gate.open(3), true, "the current provider generation opens the gate");
	assert.equal(
		gate.isRemoteProjectionAllowed("notes/ordinary.md"),
		true,
		"ordinary remote projection is admitted after policy readiness",
	);

	gate.close(4);
	assert.equal(
		gate.isRemoteProjectionAllowed("notes/ordinary.md"),
		false,
		"a reconnect closes ordinary projection for the new generation",
	);
	assert.equal(gate.open(3), false, "the previous generation cannot reopen after reconnect");
	assert.equal(gate.currentGeneration, 4);
	assert.equal(gate.readyGeneration, null);
}

console.log("\n--- Projection leases reject close/open ABA ---");

{
	const gate = new RemoteProjectionPolicyGate();
	gate.close(7);
	assert.equal(gate.open(7), true);
	const ordinaryLease = gate.captureLease(["notes/ordinary.md"]);
	assert.ok(ordinaryLease, "an open generation grants an ordinary projection lease");
	assert.equal(
		gate.isLeaseCurrent(ordinaryLease!),
		true,
		"the lease starts current",
	);

	gate.close(7);
	assert.equal(gate.open(7), true, "the same generation may become ready again");
	assert.equal(
		gate.isLeaseCurrent(ordinaryLease!),
		false,
		"a same-generation close/open cycle cannot revive the old lease",
	);

	gate.close(8);
	const controlLease = gate.captureLease([KAOS_EXCLUDE_FILE_PATH]);
	assert.ok(controlLease, "the control document can obtain a bootstrap lease while closed");
	gate.close(9);
	assert.equal(
		gate.isLeaseCurrent(controlLease!),
		false,
		"a newer provider generation invalidates an in-flight control-document lease",
	);
}

console.log("\n--- Projection reopen waits for stale filesystem commits ---");

{
	const gate = new RemoteProjectionPolicyGate();
	gate.close(10);
	assert.equal(gate.open(10), true);
	const lease = gate.captureLease(["notes/in-flight-rename.md"]);
	assert.ok(lease, "an open generation grants the filesystem operation a lease");
	const release = gate.enterCriticalSection(lease!);
	assert.ok(release, "a current lease can enter the projection commit section");

	gate.close(11);
	let retryRequested = 0;
	assert.equal(
		gate.open(11, () => { retryRequested++; }),
		false,
		"the next generation cannot open across an older async filesystem commit",
	);
	assert.equal(gate.readyGeneration, null, "projection remains closed while the old commit is active");
	assert.equal(retryRequested, 0, "the retry is not requested before the old commit settles");

	release!();
	assert.equal(retryRequested, 1, "settling the old commit requests one fresh policy-open attempt");
	assert.equal(gate.readyGeneration, null, "the retry callback does not silently open the gate");
	assert.equal(gate.open(11), true, "the fresh provider policy can open after the stale commit drains");
}

console.log("\n--- CRDT exclude-file snapshot ---");

{
	const raw = "# shared\nJOURNALS/PRIVATE/\n";
	const snapshot = readKaosExcludeFileFromCrdt({
		getActiveFileIdsForPath: (path) => {
			assert.equal(path, KAOS_EXCLUDE_FILE_PATH);
			return ["control-file-id"];
		},
		getTextForPath: (path) => {
			assert.equal(path, KAOS_EXCLUDE_FILE_PATH);
			return { toJSON: () => raw };
		},
	});
	assert.deepEqual(snapshot, {
		present: true,
		raw,
		patterns: ["JOURNALS/PRIVATE/"],
	});
}

{
	const snapshot = readKaosExcludeFileFromCrdt({
		getActiveFileIdsForPath: () => [],
		getTextForPath: () => {
			throw new Error("absent control file must not read Y.Text");
		},
	});
	assert.deepEqual(
		snapshot,
		{ present: false, raw: null, patterns: [] },
		"authoritative absence is represented explicitly",
	);
}

assert.throws(
	() => readKaosExcludeFileFromCrdt({
		getActiveFileIdsForPath: () => ["duplicate-a", "duplicate-b"],
		getTextForPath: () => ({ toJSON: () => "" }),
	}),
	/path binding/i,
	"a duplicate active control path fails closed",
);

assert.throws(
	() => readKaosExcludeFileFromCrdt({
		getActiveFileIdsForPath: () => ["control-file-id"],
		getTextForPath: () => null,
	}),
	/Y\.Text/i,
	"an active control path without Y.Text fails closed",
);

assert.throws(
	() => readKaosExcludeFileFromCrdt({
		getActiveFileIdsForPath: () => ["control-file-id"],
		getTextForPath: () => ({
			toJSON: () => "x".repeat(KAOS_EXCLUDE_FILE_MAX_CHARS + 1),
		}),
	}),
	/safety limit/i,
	"an oversized CRDT policy fails closed",
);

console.log("\n--- Reconciliation keeps local ingress separate from remote projection ---");

{
	const ordinaryPath = "JOURNALS/PRIVATE/secret.md";
	const controlText = { toJSON: () => "JOURNALS/PRIVATE/\n" };
	const ordinaryText = { toJSON: () => "secret\n" };
	const fakeVaultSync = {
		_pathIndex: new Map([
			[ordinaryPath, "ordinary-id"],
			[KAOS_EXCLUDE_FILE_PATH, "control-id"],
		]),
		_activePathCollisions: new Map(),
		_deletedPathIndex: new Set(),
		ensurePathIndexes: () => {},
		getTextForPath: (path: string) => (
			path === KAOS_EXCLUDE_FILE_PATH ? controlText : ordinaryText
		),
		isMarkdownTombstoned: () => false,
		markInitialized: () => {},
		ensureFile: () => {
			throw new Error("an empty disk must not seed CRDT");
		},
		log: () => {},
	};

	const result = VaultSync.prototype.reconcileVault.call(
		fakeVaultSync,
		new Map(),
		new Set(),
		"authoritative",
		"fresh-device",
		undefined,
		() => true,
		() => true,
		(path: string) => path === KAOS_EXCLUDE_FILE_PATH,
	);
	assert.deepEqual(
		result.createdOnDisk,
		[KAOS_EXCLUDE_FILE_PATH],
		"remote projection filters ordinary CRDT paths but admits the control document",
	);

	const localOnlyPath = "LOCAL/draft.md";
	fakeVaultSync._pathIndex = new Map();
	const localSeeded: string[] = [];
	fakeVaultSync.ensureFile = (path: string) => {
		localSeeded.push(path);
	};
	const localIngress = VaultSync.prototype.reconcileVault.call(
		fakeVaultSync,
		new Map([[localOnlyPath, "local draft\n"]]),
		new Set([localOnlyPath]),
		"authoritative",
		"fresh-device",
		undefined,
		() => true,
		() => true,
		() => false,
	);
	assert.deepEqual(
		localIngress.seededToCrdt,
		[localOnlyPath],
		"a closed remote projection gate does not block local disk-to-CRDT ingress",
	);
	assert.deepEqual(localSeeded, [localOnlyPath]);

	const overlappingPath = "notes/external-edit.md";
	fakeVaultSync._pathIndex = new Map([[overlappingPath, "overlap-id"]]);
	fakeVaultSync.getTextForPath = (path: string) => (
		path === overlappingPath ? { toJSON: () => "cached crdt\n" } : null
	);
	const overlappingIngress = VaultSync.prototype.reconcileVault.call(
		fakeVaultSync,
		new Map([[overlappingPath, "external disk edit\n"]]),
		new Set([overlappingPath]),
		"authoritative",
		"fresh-device",
		undefined,
		() => true,
		() => true,
		() => false,
	);
	assert.deepEqual(
		overlappingIngress.updatedOnDisk,
		[overlappingPath],
		"a closed projection gate still classifies overlapping disk/CRDT divergence for three-way local ingress",
	);
}

console.log("PASS remote projection policy gate");
