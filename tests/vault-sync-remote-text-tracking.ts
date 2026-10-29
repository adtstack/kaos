import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { RemoteTextRevisionTracker } from "../src/sync/remoteTextRevisionTracker";
import { LocalOnlyRecoveryEvidence, localOnlyRecoveryBlockReason } from "../src/sync/localOnlyRecoveryEvidence";
import { VaultSync } from "../src/sync/vaultSync";
import { ORIGIN_DISK_SYNC, ORIGIN_SEED } from "../src/sync/origins";

function fixture() {
 const doc = new Y.Doc();
 const texts = doc.getMap<Y.Text>("idToText");
 const meta = doc.getMap<unknown>("meta");
 const provider = {}; const persistence = {}; const local = {};
 const tracker = new RemoteTextRevisionTracker(doc, texts, () => provider, () => persistence);
 tracker.registerEditorOrigin(local);
 doc.transact(() => { texts.set("a", new Y.Text("BASE")); texts.set("b", new Y.Text("OTHER")); }, ORIGIN_SEED);
 const text = texts.get("a")!;
 const revision = () => tracker.get(text, "a")!;
 const evidence = new LocalOnlyRecoveryEvidence(); const identity = {};
 const update = (editor: string, before: string | null, source: "local" | "projection" | "reload" | "unknown" = "projection", complete = true) =>
  evidence.update({ identity, revision: revision(), editor, before, crdt: text.toString(), source, complete });
 return { doc, texts, meta, provider, persistence, local, tracker, text, revision, evidence, identity, update };
}

// A-T01/A-T02/A-T03: independent checkpoint and local successor evidence.
{
 const f = fixture();
 assert.equal(localOnlyRecoveryBlockReason(f.revision(), [null], ["BASE"]), "initial-authority-unverified");
 f.update("BASE", null);
 f.doc.transact(() => f.text.insert(4, "-REMOTE"), f.provider);
 assert.equal(localOnlyRecoveryBlockReason(f.revision(), [f.evidence.get()], ["BASE"]), "remote-not-acknowledged");
 f.update("BASE-REMOTE", "BASE");
 f.update("BASE-REMOTE-local", "BASE-REMOTE", "local");
 assert.equal(localOnlyRecoveryBlockReason(f.revision(), [f.evidence.get()], ["BASE-REMOTE-local"]), null);
 // A newer pane cannot bless a pane that never reflected the remote update.
 assert.equal(localOnlyRecoveryBlockReason(f.revision(), [f.evidence.get(), null], ["BASE-REMOTE-local", "BASE-REMOTE-local"]), "initial-authority-unverified");
 const second = new LocalOnlyRecoveryEvidence();
 second.update({ identity: {}, revision: f.revision(), before: null, editor: f.text.toString(), crdt: f.text.toString(), source: "projection", complete: true });
 second.update({ identity: {}, revision: f.revision(), before: f.text.toString(), editor: "BASE-REMOTE-local", crdt: f.text.toString(), source: "local", complete: true });
 assert.equal(second.get(), null, "binding/CM epoch identity must match");
 f.doc.destroy(); f.tracker.destroy();
}

// A-T04: revision ordering survives identical timestamps and clock reversal,
// including remote delete+insert whose final bytes equal the preimage.
{
 const f = fixture(); const savedNow = Date.now;
 try {
  Date.now = () => 1000;
  const before = f.revision();
  let seenByTextObserver = 0;
  f.text.observe(() => { seenByTextObserver = f.revision().remoteRevision; });
  f.doc.transact(() => { f.text.delete(0, 4); f.text.insert(0, "BASE"); }, f.provider);
  assert.equal(f.text.toString(), "BASE");
  assert.equal(f.revision().remoteRevision, before.remoteRevision + 1);
  assert.equal(f.tracker.getNormalizedContent(before), null, "stale revisions cannot read a later text snapshot");
  assert.equal(seenByTextObserver, f.revision().remoteRevision, "revision precedes text projection");
  Date.now = () => 1;
  f.doc.transact(() => f.text.insert(4, "R"), f.provider);
  assert.equal(f.revision().remoteRevision, before.remoteRevision + 2);
  const remote = f.revision().remoteRevision;
  const authority = f.revision().authorityRevision;
  f.doc.transact(() => f.text.insert(5, "L"), f.local);
  assert.equal(f.revision().remoteRevision, remote);
  assert.equal(f.revision().authorityRevision, authority);
  for (const origin of [ORIGIN_DISK_SYNC, f.persistence, "unknown-origin", null, {}]) {
   const prior = f.revision();
   f.doc.transact(() => f.text.insert(f.text.length, "."), origin);
   assert.equal(f.revision().remoteRevision, remote);
   assert.equal(f.revision().authorityRevision, prior.authorityRevision + 1);
  }
 } finally { Date.now = savedNow; f.tracker.destroy(); f.doc.destroy(); }
}

// A-T05: cache miss, nested integration, replacement, meta late, rename,
// tombstone/recreate, other file, and listener teardown.
{
 const f = fixture(); const otherBefore = f.tracker.get(f.texts.get("b")!, "b")!;
 const before = f.revision();
 f.doc.transact(() => f.texts.set("new", new Y.Text("REMOTE-NEW")), f.provider);
 const added = f.texts.get("new")!;
 assert.equal(f.tracker.get(added, "new")!.remoteRevision, 1);
 assert.equal(f.revision(), before, "another file cannot contaminate this path");
 assert.equal(f.tracker.get(f.texts.get("b")!, "b"), otherBefore);
 const lookup = {
  idToText: f.texts, remoteTextRevisions: f.tracker,
  getFileId: (path: string) => [...f.meta].find(([, v]) => (v as { path?: string; deleted?: boolean }).path === path && !(v as { deleted?: boolean }).deleted)?.[0] ?? null,
 };
 const forPath = (path: string) => VaultSync.prototype.getRemoteTextRevisionForPath.call(lookup as never, path);
 assert.equal(forPath("new.md"), null);
 f.meta.set("new", { path: "new.md" });
 assert.equal(forPath("new.md")!.remoteRevision, 1, "late metadata preserves the original revision");
 const scope = forPath("new.md")!.scope;
 f.meta.set("new", { path: "renamed.md" });
 assert.equal(forPath("new.md"), null);
 assert.equal(forPath("renamed.md")!.scope, scope);
 f.meta.set("new", { path: "renamed.md", deleted: true });
 assert.equal(forPath("renamed.md"), null);
 f.doc.transact(() => { f.texts.set("new", new Y.Text("RECREATED")); f.meta.set("new", { path: "renamed.md" }); }, f.provider);
 assert.notEqual(forPath("renamed.md")!.scope, scope);
 assert.equal(f.tracker.get(added, "new"), null);
 let notifications = 0; f.tracker.subscribe(() => { notifications++; });
 f.tracker.destroy(); f.text.insert(0, "after-teardown");
 assert.equal(notifications, 0); assert.equal(f.revision(), null);
 f.doc.destroy();
}

// A-T06: real IndexedDB hydration and identical provider echo do not grant
// initial authority, regardless of whether hydration follows provider sync.
{
 const name = `kaos-local-only-test-${Math.random()}`;
 const first = fixture();
 const store = new IndexeddbPersistence(name, first.doc); await store.whenSynced;
 first.doc.transact(() => first.text.insert(4, "-REMOTE"), first.provider);
 await store.destroy(); first.tracker.destroy(); first.doc.destroy();
 for (const providerFirst of [false, true]) {
  const doc = new Y.Doc(); const texts = doc.getMap<Y.Text>("idToText"); const provider = {};
  let persistence: IndexeddbPersistence | null = null;
  const tracker = new RemoteTextRevisionTracker(doc, texts, () => provider, () => persistence);
  const remote = new Y.Doc(); const remoteStore = new IndexeddbPersistence(name, remote); await remoteStore.whenSynced;
  const update = Y.encodeStateAsUpdate(remote);
  if (providerFirst) Y.applyUpdate(doc, update, provider);
  persistence = new IndexeddbPersistence(name, doc); await persistence.whenSynced;
  const text = texts.get("a")!; const before = tracker.get(text, "a")!;
  Y.applyUpdate(doc, update, provider);
  assert.equal(text.toString(), "BASE-REMOTE");
  assert.equal(tracker.get(text, "a"), before, "duplicate echo has no text change");
  assert.equal(localOnlyRecoveryBlockReason(before, [null], ["BASE"]), "initial-authority-unverified");
  await persistence.destroy(); await remoteStore.destroy(); tracker.destroy(); doc.destroy(); remote.destroy();
 }
 await store.clearData();
}

// A-T07/A-T08: proven local API/undo successors, reload invalidation,
// composition partial state, and BOM/CRLF equivalence use the same pure rule.
for (const localKind of ["input", "programmatic", "completion", "undo", "redo"]) {
 const f = fixture(); f.update("\uFEFFBASE\r\n", null);
 // Establish equivalent line endings without changing raw comparison policy.
 f.doc.transact(() => f.text.insert(4, "\r\n"), f.provider);
 f.update("\uFEFFBASE\n", "BASE");
 assert.equal(f.evidence.get()!.localSuccessor, false);
 f.update("BASE\nlocal", "\uFEFFBASE\r\n", "local");
 assert.equal(localOnlyRecoveryBlockReason(f.revision(), [f.evidence.get()], ["BASE\r\nlocal"]), null, localKind);
 const raw = f.text.toString();
 f.update("stale disk", "BASE\nlocal", "reload"); assert.equal(f.evidence.get(), null);
 f.update(raw, null); f.update("partial IME", raw, "local", false); assert.equal(f.evidence.get(), null);
 assert.equal(f.text.toString(), raw, "evidence collection never edits CRDT");
 f.tracker.destroy(); f.doc.destroy();
}
console.log("PASS remote tracking, hydration, per-pane evidence and normalization boundary cases");
