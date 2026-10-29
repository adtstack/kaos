import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import "fake-indexeddb/auto";
import { EditorState, Transaction } from "@codemirror/state";
import * as Y from "yjs";
import { FlightTraceController } from "../src/telemetry/debug/flightTraceController";
import { EditorBindingManager } from "../src/sync/editorBinding";
import { DiskMirror } from "../src/sync/diskMirror";
import { ORIGIN_DISK_SYNC_RECOVER_BOUND } from "../src/sync/origins";
import { analyzeEditorCausality, type CausalityEvent } from "../qa/analyzers/editorCausality";
import type { ProductFlightPathEventInput, ContentTraceSamples } from "../src/observability/traceSink";

const written: string[] = [];
const files = new Map<string, string>();
const app = { vault: { configDir: ".obsidian", adapter: {
	append: async (path: string, content: string) => {
		written.push(content); files.set(path, (files.get(path) ?? "") + content);
	},
	mkdir: async () => {}, exists: async () => false,
	list: async (dir: string) => ({ files: [...files.keys()].filter(path => path.startsWith(`${dir}/`)), folders: [] }),
	read: async (path: string) => files.get(path) ?? "",
	write: async (path: string, content: string) => { files.set(path, content); },
} } };
const controller = new FlightTraceController({
	app: app as never,
	getSettings: () => ({ vaultId: "test-vault", host: "https://example.test" }) as never,
	getPluginVersion: () => "1.13.3", getDocSchemaVersion: () => 4,
	buildCheckpoint: async () => ({}), registerCleanup: () => {}, log: () => {},
});
const path = "private-name.md";
const baseEvent: ProductFlightPathEventInput = {
	kind: "editor.causality.observed", scope: "file", source: "editorBinding", layer: "editor",
	severity: "info", path, data: { phase: "trace-start" },
};
controller.recordContentPath(baseEvent, { editorAfter: "should not be read or written" });
assert.equal(controller.currentSeq, 0, "disabled observation is a no-op");
await controller.start("safe");

const doc = new Y.Doc();
const ytext = doc.getText("note");
ytext.insert(0, "private-body-OLD");
const provider = {};
const persistence = {};
const vaultSync = { provider, persistence, connectionGeneration: 2 };
const observer = {
	isEnabled: () => controller.canRecordContent,
	record: (event: ProductFlightPathEventInput, samples: ContentTraceSamples) => controller.recordContentPath(event, samples),
};
const manager = new EditorBindingManager(vaultSync as never, false, () => true,
	undefined, undefined, undefined, undefined, undefined, undefined, observer);
const cm = { state: EditorState.create({ doc: ytext.toJSON() }), dom: { isConnected: true } };
const binding = {
	view: { file: { path }, editor: { getValue: () => cm.state.doc.toString() } }, path, ytext, cm,
	cmId: "cm-1", lastEditorDocChangeAtMs: null, lastEditorChangeAtMs: Date.now(),
};
const internal = manager as unknown as {
	bindings: Map<string, unknown>;
	findBindingForCm: () => { leafId: string; binding: unknown };
	findBindingForState: () => { leafId: string; binding: unknown };
	scheduleHealthCheck: () => void;
	publishLocalTypingActivity: () => void;
	recordYTextPatch: (text: Y.Text, path: string, leaf: string, transaction: Y.Transaction, event: Y.YTextEvent) => void;
	handleLiveEditorUpdate: (update: unknown) => void;
};
internal.bindings.set("leaf-1", binding);
internal.findBindingForCm = () => ({ leafId: "leaf-1", binding });
internal.findBindingForState = () => ({ leafId: "leaf-1", binding });
internal.scheduleHealthCheck = () => {};
internal.publishLocalTypingActivity = () => {};
ytext.observe((event, transaction) => internal.recordYTextPatch(ytext, path, "leaf-1", transaction, event));
assert.equal(manager.captureCausalitySnapshot("trace-start"), 1);

function editorUpdate(content: string, userEvent?: string) {
	const transaction = cm.state.update({
		changes: { from: 0, to: cm.state.doc.length, insert: content },
		annotations: userEvent ? Transaction.userEvent.of(userEvent) : [],
	});
	cm.state = transaction.state;
	internal.handleLiveEditorUpdate({ view: cm, docChanged: true, transactions: [transaction] });
}

editorUpdate("private-body-NEW", "input.type"); // Deliberately omit CM→Y propagation.
doc.transact(() => { ytext.insert(ytext.length, "!"); }, provider);
editorUpdate(ytext.toJSON());
doc.transact(() => { ytext.delete(ytext.length - 1, 1); }, ORIGIN_DISK_SYNC_RECOVER_BOUND);
editorUpdate(ytext.toJSON()); // Exact return to the trace-start editor state.
manager.captureCausalitySnapshot("symptom-marked");
editorUpdate("private-body-NEW", "input.type");
doc.transact(() => {
	ytext.delete(0, ytext.length); ytext.insert(0, "private-body-NEW");
}, "disk-sync");
const peer = new Y.Doc();
Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
const peerText = peer.getText("note");
peer.transact(() => {
	peerText.delete(0, peerText.length); peerText.insert(0, "private-body-OLD");
});
Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)), provider);
editorUpdate(ytext.toJSON());
peer.destroy();
await controller.flush();
const recorder = controller.currentRecorder!;
const events = recorder.recentEvents as CausalityEvent[];
const causal = events.filter(event => event.kind === "editor.causality.observed");
assert(causal.some(event => event.data?.originKind === "provider"));
assert(causal.some(event => event.data?.originName === ORIGIN_DISK_SYNC_RECOVER_BOUND));
assert(causal.some(event => event.data?.phase === "editor-update" && event.data.editorEqualsCrdt === false));
assert(causal.every(event => event.data?.captureStatus === "ok"));
assert(causal.every(event => typeof event.data?.observedMono === "number"));
assert(causal.every(event => event.data?.yTextId === causal[0]!.data?.yTextId));
assert.equal(cm.state.doc.toString(), "private-body-OLD", "observer never changes the editor");
assert.equal(ytext.toJSON(), "private-body-OLD", "observer never changes CRDT");
const report = analyzeEditorCausality(events);
assert(report.observations.some(item => item.kind === "editor-crdt-diverged-after-input"));
assert(report.observations.some(item => item.candidates?.includes("local-repair-crdt-projection")));
assert(report.observations.some(item => item.candidates?.includes("provider-crdt-projection")));
assert(causal.some(event => event.data?.originKind === "provider" && event.data.transactionLocal === false));
assert(causal.some(event => typeof event.data?.deletedChars === "number" && event.data.deletedChars > 0));
assert(report.observations.some(item => item.kind === "user-reported-rollback"));
assert.equal(report.status, "OBSERVED");
const cliDir = mkdtempSync(join(tmpdir(), "kaos-editor-causality-"));
try {
	const fixture = join(cliDir, "flight.ndjson");
	writeFileSync(fixture, events.map(event => JSON.stringify(event)).join("\n") + "\n");
	const cli = spawnSync(process.execPath, ["--import", "jiti/register", "qa/scripts/analyze-editor-causality.ts", fixture], { encoding: "utf8" });
	assert.equal(cli.status, 0, cli.stderr);
	assert.equal(JSON.parse(cli.stdout).status, "OBSERVED");
	writeFileSync(fixture, "broken JSON\n");
	const bad = spawnSync(process.execPath, ["--import", "jiti/register", "qa/scripts/analyze-editor-causality.ts", fixture], { encoding: "utf8" });
	assert.notEqual(bad.status, 0, "CLI refuses malformed evidence");
} finally { rmSync(cliDir, { recursive: true, force: true }); }
const serialized = written.join("");
assert(!serialized.includes("private-body"), "no raw body in persisted telemetry");
assert(!serialized.includes(path), "safe path pseudonym survives content observations");
assert(!serialized.includes("should not be read or written"));
controller.recordContentPath(baseEvent, { editorAfter: "pending-at-export" });
internal.bindings.delete("leaf-1");
internal.bindings.set(path, binding);
manager.captureCausalitySnapshot("symptom-marked"); // Host leaf ID can fall back to a raw path.
const exported = await controller.exportTrace({ requestedPrivacy: "safe", diagDir: "/diagnostics" });
assert(exported.ok, "safe export succeeds with causality records");
if (exported.ok) {
	const content = files.get(exported.path)!;
	assert(content.includes('"editorAfterLength":17'), "export drains pending content hashing");
	assert(!content.includes("private-body") && !content.includes(path));
}

// Preserve observation order when one hash batch is much larger than another.
const startSeq = controller.currentSeq;
controller.recordContentPath(baseEvent, { editorAfter: "x".repeat(200_000) });
controller.recordContentPath(baseEvent, { editorAfter: "small" });
await controller.flush();
const ordered = recorder.recentEvents.filter(event => event.seq > startSeq).sort((a, b) => a.seq - b.seq);
assert.equal(ordered[0]!.data?.editorAfterLength, 200_000);
assert.equal(ordered[1]!.data?.editorAfterLength, 5);

controller.recordContentPath(baseEvent, { editorAfter: "x".repeat(4_000_001) });
await controller.flush();
assert(recorder.recentEvents.some(event => event.data?.captureStatus === "capacity-exceeded"));
assert.equal(analyzeEditorCausality(recorder.recentEvents as CausalityEvent[]).status, "INSUFFICIENT_EVIDENCE");

// Observe physical write evidence once, with hashes only when tracing is enabled.
const diskMirror = new DiskMirror({} as never, vaultSync as never, manager, false);
diskMirror.setContentTraceObserver(observer);
let fallbackEvents = 0;
diskMirror.setFlightEventHandler(() => { fallbackEvents++; });
const diskInternal = diskMirror as unknown as {
	recordSuccessfulWrite: (path: string, content: string, create: boolean, baseline: boolean) => void;
};
diskInternal.recordSuccessfulWrite(path, "private-body-OLD", false, true);
await controller.flush();
assert.equal(fallbackEvents, 0, "no duplicate success event from observation");
assert.equal(recorder.recentEvents.filter(event => event.kind === "disk.write.ok").length, 1);
assert.equal(recorder.recentEvents.find(event => event.kind === "disk.write.ok")!.data?.diskHash,
	causal[0]!.data?.editorAfterHash, "disk/editor samples use the same exact hash domain");

// Stop must persist the final sample even if it was still hashing at stop.
controller.recordContentPath(baseEvent, { editorAfter: "pending-on-stop" });
await controller.stop();
assert(written.join("").includes('"editorAfterLength":15'));
diskInternal.recordSuccessfulWrite(path, "unused", false, true);
assert.equal(fallbackEvents, 1, "disabled tracing keeps existing write event behavior");

const simple = (seq: number, data: Record<string, unknown>, deviceId = "device-a"): CausalityEvent => ({
	kind: "editor.causality.observed", seq, deviceId, bootId: "boot-a", traceId: "trace-a", pathId: "p:a",
	data: { cmId: "cm-1", yTextId: 1, bindingEpoch: 1, contentHashDomain: "local", captureStatus: "ok", ...data },
});
const history = [simple(1, { phase: "trace-start", editorAfterHash: "OLD" }),
	simple(2, { phase: "editor-update", editorBeforeHash: "OLD", editorAfterHash: "NEW", userDocChanged: true })];
assert.equal(analyzeEditorCausality([...history, simple(3, {
	phase: "editor-update", editorBeforeHash: "NEW", editorAfterHash: "OLD", undoOrRedo: true,
})]).observations.length, 0, "intentional undo is not classified as unwanted rollback");
assert.equal(analyzeEditorCausality([...history, simple(3, {
	phase: "editor-update", editorBeforeHash: "NEW", editorAfterHash: "OLD", nonUserDocChanged: true,
}, "device-b")]).observations.length, 0, "history does not cross devices");
assert.equal(analyzeEditorCausality([]).status, "INSUFFICIENT_EVIDENCE");
assert.equal(analyzeEditorCausality([...history, simple(3, {
	phase: "editor-update", editorBeforeHash: "NEW", editorAfterHash: "OLD", runtimeId: 99,
	 nonUserDocChanged: true,
})]).observations.length, 0, "history does not cross reinitialized editor runtimes");
const lateDisk: CausalityEvent = {
	...simple(3, {}), kind: "disk.modify.classified", data: {
		captureStatus: "ok", contentHashDomain: "local", runtimeCurrent: true,
		diskHash: "BOM_OLD", diskEditorNormalizedHash: "OLD", classification: "not-self-write",
	},
};
const diskReport = analyzeEditorCausality([...history, lateDisk, simple(4, {
	phase: "editor-update", editorBeforeHash: "NEW", editorAfterHash: "OLD", nonUserDocChanged: true,
})]);
assert(diskReport.observations.some(item => item.candidates?.includes("disk-reload:not-self-write")),
	"disk source matching uses editor-normalized bytes while retaining raw-byte evidence");
doc.destroy();
console.log("PASS editor causality: live snapshots, origins, passive state, privacy, flush, bounds and classification");
