import {
	planOpenBoundFileReconcile,
	type OpenBoundFileReconcileInput,
} from "../src/runtime/reconcile/openBoundFilePlanner";

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

const HASH_BASE = "base";
const HASH_DISK = "disk";
const HASH_CRDT = "crdt";

function input(overrides: Partial<OpenBoundFileReconcileInput> = {}): OpenBoundFileReconcileInput {
	return {
		diskHash: HASH_DISK,
		crdtHash: HASH_CRDT,
		baselineHash: HASH_BASE,
		editorAuthority: { kind: "single", relation: "disk" },
		hasRecentEditorActivity: false,
		...overrides,
	};
}

console.log("\n--- Test 1: disk-only changed imports disk to CRDT ---");
{
	const action = planOpenBoundFileReconcile(input({
		diskHash: HASH_DISK,
		crdtHash: HASH_BASE,
		baselineHash: HASH_BASE,
		editorAuthority: { kind: "single", relation: "disk" },
	}));
	assert(action.kind === "import-disk-to-crdt", "disk-only change imports disk");
	assert(action.kind === "import-disk-to-crdt" && action.reason === "crdt-at-baseline", "reason is crdt-at-baseline");
}

console.log("\n--- Test 2: CRDT-only changed applies CRDT to disk ---");
{
	const action = planOpenBoundFileReconcile(input({
		diskHash: HASH_BASE,
		crdtHash: HASH_CRDT,
		baselineHash: HASH_BASE,
		editorAuthority: { kind: "single", relation: "crdt" },
	}));
	assert(action.kind === "apply-crdt-to-disk", "CRDT-only change applies CRDT to disk");
	assert(action.kind === "apply-crdt-to-disk" && action.reason === "disk-at-baseline", "reason is disk-at-baseline");
}

console.log("\n--- Test 3: both changed and editor matches disk preserves CRDT ---");
{
	const action = planOpenBoundFileReconcile(input({
		editorAuthority: { kind: "single", relation: "disk" },
	}));
	assert(action.kind === "import-disk-to-crdt", "disk/editor side wins");
	assert(action.kind === "import-disk-to-crdt" && action.preserveCrdt === true, "CRDT side is preserved");
}

console.log("\n--- Test 4: both changed and editor matches CRDT preserves disk ---");
{
	const action = planOpenBoundFileReconcile(input({
		editorAuthority: { kind: "single", relation: "crdt" },
	}));
	assert(action.kind === "editor-wins-preserve", "CRDT/editor side wins through editor authority");
	assert(action.kind === "editor-wins-preserve" && action.preserveDisk === true, "disk side is preserved");
}

console.log("\n--- Test 5: editor distinct from disk and CRDT wins and preserves both ---");
{
	const action = planOpenBoundFileReconcile(input({
		editorAuthority: { kind: "single", relation: "distinct" },
	}));
	assert(action.kind === "editor-wins-preserve", "distinct editor authority wins");
	assert(action.kind === "editor-wins-preserve" && action.preserveDisk === true, "disk side is preserved");
	assert(action.kind === "editor-wins-preserve" && action.preserveCrdt === true, "CRDT side is preserved");
}

console.log("\n--- Test 6: multiple or unreadable editors are ambiguous ---");
{
	const multiple = planOpenBoundFileReconcile(input({
		editorAuthority: { kind: "multiple" },
	}));
	const readFailed = planOpenBoundFileReconcile(input({
		editorAuthority: { kind: "read-failed" },
	}));
	assert(multiple.kind === "ambiguous-conflict", "multiple editor authorities are ambiguous");
	assert(readFailed.kind === "ambiguous-conflict", "read-failed editor authority is ambiguous");
}

console.log("\n--- Test 7: missing baseline with disk newer lets disk win and preserves CRDT ---");
{
	const action = planOpenBoundFileReconcile(input({
		baselineHash: null,
		editorAuthority: { kind: "single", relation: "disk" },
		diskMtime: 2000,
		lastDiskIndexPersistedAt: 1000,
	}));
	assert(action.kind === "import-disk-to-crdt", "disk wins with mtime evidence");
	assert(action.kind === "import-disk-to-crdt" && action.preserveCrdt === true, "CRDT is preserved");
	assert(
		action.kind === "import-disk-to-crdt" &&
			action.missingBaselinePolicy === "disk-mtime-after-last-index-save",
		"missing-baseline policy is recorded",
	);
}

console.log("\n--- Test 8: missing baseline without evidence follows visible open-file authority ---");
{
	const passiveDiskEditor = planOpenBoundFileReconcile(input({
		baselineHash: null,
		editorAuthority: { kind: "single", relation: "disk" },
	}));
	const passiveCrdtEditor = planOpenBoundFileReconcile(input({
		baselineHash: null,
		editorAuthority: { kind: "single", relation: "crdt" },
	}));
	const distinctEditor = planOpenBoundFileReconcile(input({
		baselineHash: null,
		editorAuthority: { kind: "single", relation: "distinct" },
	}));
	assert(passiveDiskEditor.kind === "import-disk-to-crdt", "disk/editor side wins without durable baseline evidence");
	assert(passiveDiskEditor.kind === "import-disk-to-crdt" && passiveDiskEditor.preserveCrdt === true, "CRDT side is preserved");
	assert(
		passiveDiskEditor.kind === "import-disk-to-crdt" &&
			passiveDiskEditor.missingBaselinePolicy === "open-bound-visible-authority",
		"open-bound policy is recorded for disk/editor authority",
	);
	assert(passiveCrdtEditor.kind === "import-disk-to-crdt", "crdtOnly external disk edit imports disk without durable baseline evidence");
	assert(passiveCrdtEditor.kind === "import-disk-to-crdt" && passiveCrdtEditor.preserveCrdt === true, "visible CRDT side is preserved once");
	assert(
		passiveCrdtEditor.kind === "import-disk-to-crdt" &&
			passiveCrdtEditor.missingBaselinePolicy === "open-bound-visible-authority",
		"open-bound policy is recorded for crdtOnly authority",
	);
	assert(distinctEditor.kind === "editor-wins-preserve", "distinct editor authority still wins");
}

console.log("\n--- Test 9: recent editor activity defers any authority choice ---");
{
	const action = planOpenBoundFileReconcile(input({
		hasRecentEditorActivity: true,
		editorAuthority: { kind: "single", relation: "disk" },
	}));
	assert(action.kind === "defer-recent-editor", "recent editor activity defers");
}

console.log(`\n${"-".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"-".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
