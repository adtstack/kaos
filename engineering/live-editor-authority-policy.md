# Live Editor Authority Policy

Status: active policy as of 2026-07-25.

This document records the policy for protecting an open CodeMirror/Yjs editor
from stale whole-document style patches while preserving normal live
collaboration.

## Decision

Use recent local typing as the protection boundary for Y.Text-origin repair
patches. Treat an external disk reload as a separate candidate that always
enters reconciliation, including while the note is open.

Do not use "the file is open" as the boundary.
Do not merge inside the CodeMirror binding or make disk a second live
authority. Baseline-aware planning belongs to `ReconciliationController`, and
any accepted result enters the editor through a targeted Y.Text transaction.
Do not remove editor binding or cursor state unless the recent-typing shield
still fails in production.

Current Yjs policy:

1. Let normal Yjs collaboration patches flow.
2. Let any incoming patch flow when it preserves the current editor content.
3. If an incoming non-user patch would remove current editor content, treat it
   as destructive.
4. Shield an eligible named local-repair patch only when this device has a real
   document edit for the same binding within
   `RECENT_EDITOR_PATCH_SHIELD_MS` (currently 5000 ms).
5. If the editor is merely open but has no recent local typing, do not shield
   the patch.
6. Provider-origin patches are never converted into whole-document editor
   writebacks by this shield.
7. If conflict preservation or a three-way decision is needed, use the
   reconciliation path outside the binding. The binding never chooses a merge
   winner.

Current external-disk policy:

1. "External" describes an event route, not whether the change is trusted or
   intended. It includes user scripts, other Obsidian plugins that write via
   `Vault.modify`/the filesystem, and separate editors.
2. A plugin change made through the live editor/CodeMirror API remains an
   editor-origin change. Its Yjs propagation and following autosave continue
   through the normal editor flow.
3. A correlated external reload never becomes an editor-origin Y.Text update.
   The raw reload is intercepted and its exact disk candidate is handed to
   `ReconciliationController` for baseline-aware planning.
4. A timing-based `writerGuess` is diagnostics only. If a modify event lands
	inside KAOS's self-write window, that event's exact TFile identity/stat
	revision and bytes must match the recent intended-write fingerprint. A later
	file revision cannot prove an older event. A mismatch enters the external
	reload guard without consuming normal reconciliation suppression state.
5. The disk event and the following non-user CodeMirror replacement are
	correlated by exact content after BOM/line-ending normalization, not by byte
	size. The replacement is cancelled before y-codemirror can copy it into
	Y.Text. Same-size unrelated plugin/API edits remain normal editor changes.
6. If a host reports the editor replacement first, rollback is allowed only
	when the exact disk content matches and either the synchronously captured
	event sequence or a matching high-resolution mtime proves the disk write came
	first. The exact binding, CodeMirror, Y.Text, epoch, revision, and content
	snapshots must remain unchanged. If newer state prevents rollback, the disk
	candidate is still preserved. Ambiguous coarse-mtime cases keep the
	editor/API change rather than risk rolling it back.
7. Reconciliation compares durable baseline `B`, current editor/Y.Text
   authority `L`, and stable disk candidate `D`. Non-overlapping changes enter
   one targeted Y.Text transaction; overlapping or adjacent hunks do not
   partially apply.
8. When a safe mutation cannot be proven, the complete external bytes remain
   recoverable as a disk-sourced local conflict note and the primary Y.Text is
   left unchanged.
9. There is no user-facing or production-runtime external-edit policy. The
   only behavior is `include-open-files-safely`; serialized `always`/`1` fields
   exist solely for downgrade compatibility.

## Why "open" Is Not Enough

An open editor can be passive. Two devices may have the same note open while
only one device is actively editing. If the passive device blocks destructive
patches just because the file is open, it can keep reasserting old local editor
state and make the active device's edits appear to bounce back.

This was the failure shape where two devices on the same page could not type
even one character.

The correct signal is not visibility. The correct signal is recent user
document activity on that device.

## Why the Binding Does Not Merge

Closed-file reconciliation can use 3-way text merge because it owns a clear
authority decision: disk, CRDT, and baseline are explicit inputs.

The live editor already has two sophisticated state machines:

- Yjs CRDT merge semantics
- CodeMirror document, selection, and undo semantics

Adding a separate string-level auto-merge inside the live editor would create a
third authority. Instead, the controller performs an asynchronous three-way
plan from stable `B/L/D` inputs. A clean target is applied to Y.Text with a
dedicated local reconciliation origin, so y-codemirror maps the delta while
preserving selections, scroll state, and user undo boundaries. If the plan is
ambiguous or any captured authority advances, KAOS preserves or replans rather
than inventing a document in the binding layer.

## Policy Matrix

| Situation | Action | Rationale |
|---|---|---|
| User transaction from this editor | Allow | This is the local source of truth. |
| Non-user patch preserves editor content | Allow | Remote content is additive or compatible with local editor state. |
| Destructive patch, no recent local typing | Allow | The open editor is passive; blocking would resurrect stale state. |
| Destructive named local-repair patch, recent local typing | Shield | Prevent a stale local recovery decision from overwriting active input. |
| Provider-origin Y.Text patch, including destructive content | Allow | Preserve Yjs collaboration semantics; never turn it into whole-document local writeback. |
| Plugin writes through the editor/CodeMirror API | Allow normal editor/Yjs flow and autosave | This is an editor-origin operation even though it is non-user/programmatic. |
| Script, plugin `Vault.modify`, or separate editor writes disk while the note is open | Intercept the correlated reload and route the exact candidate to controller reconciliation | These are legitimate disk-origin changes, but they must not silently replace the open editor. |
| External and editor changes touch separate hunks | Apply the clean target as one targeted Y.Text transaction | Y.Text remains the live authority and every pane receives the mapped CRDT delta. |
| External and editor changes overlap, are adjacent, or lack an exact baseline | Keep current Y.Text and preserve the complete external candidate | No partial primary-file application without proof. |
| Same note open on another idle device | Allow remote updates | Open-only blocking causes cross-device deadlock. |
| Same note actively typed on both devices | Let Yjs handle normal collaboration; shield only an eligible named local-repair replacement | Avoid replacing CRDT semantics with plugin string merge. |

## Shield Behavior

The shield is narrow:

- It runs in `EditorBindingManager.filterRiskyNonUserPatch`.
- It only considers non-user document changes.
- It only applies when incoming content does not preserve current editor
  content.
- It only applies when `lastEditorDocChangeAtMs` is inside the recent typing
  window.
- It temporarily detaches the yCollab compartment before the destructive patch
  can reach CodeMirror, writes the editor authority back to Y.Text with
  `ORIGIN_EDITOR_AUTHORITY_SHIELD`, then rebinds.

This is intentionally not a general conflict resolver. It is a last-second
guard against active typing loss.

## External Reload Guard

The external reload guard runs before the recent-typing shield. It first
classifies the direction of a CodeMirror transaction from live state:

- `Y.Text == incoming editor document` means Y.Text changed first. This is a
  provider or local-repair patch and continues through the normal Yjs path.
- Otherwise, a non-user replacement whose normalized content exactly matches
	the correlated event's stable raw disk read is rejected. This remains true
	during a transient provider/editor skew, so a provider advance cannot open a
	disk-reload bypass.
- Without a preceding disk marker, `Y.Text == current editor document` records
  a short-lived editor-first candidate for the reverse event ordering.

A user transaction always passes through, but it does not erase an exact pending
disk candidate: a delayed reload of those same bytes is still blocked, while an
unrelated programmatic editor/API change remains normal. This also lets late
proof preserve the external bytes without rolling back newer user authority.
The regular transaction filter is not the only enforcement point. A final
transaction extender rechecks exact provenance after every filter and also runs
for `filter: false`. If another extension recreates a cancelled replacement, or
a caller bypasses filters, the final transaction is marked as an external
reload and a post-update compare-and-revert restores the prior editor/Y.Text
state only while the exact binding lineage and contents are unchanged. The
external bytes are still preserved exactly once.
Event order is recorded synchronously before the asynchronous exact-content
read, and the read revalidates path, TFile identity, ctime, mtime, and size
before and after I/O. Out-of-order completions cannot replace a newer marker;
their proven bytes are preserved off-path. Closing the last bound pane or
resetting the runtime invalidates the guard state, so an older asynchronous
proof cannot arm a reopened editor or a new runtime lifetime.

Rollback uses `ORIGIN_EDITOR_EXTERNAL_RELOAD_REJECT`, which is registered as a
local repair origin so DiskMirror does not echo the rejection back to disk.

## Reconciliation Compare-and-Commit

Reconciliation keeps its existing disk/CRDT/editor authority rules. An open
editor does not become the unconditional winner. Instead, any reconciliation
branch that may replace or seed CRDT content for an open file uses an
optimistic mutation ticket:

1. Capture the visible view set, file path, CodeMirror instance/document,
   editor revision and content, binding epoch, and decision-time CRDT content.
2. Load the exact durable baseline, stable disk candidate, and any preservation
   evidence required by the controller-owned plan.
3. Immediately before mutating Y.Text, verify that the complete ticket and the
   CRDT content are unchanged.
4. If any part changed, do not commit the stale decision. Defer the path and
   let reconciliation evaluate the new state again.

This closes the file-open and file-create transition where the first local
input can arrive after an authority decision but before its write. It also
avoids restoring the older open-editor-owns-everything model, so passive open
files and normal Yjs collaboration retain their current behavior.

Deferred visible-authority snapshots use a second, narrower revision in the
same ticket. A general CodeMirror revision advances for every document change,
including provider/Y.Text patches. The editor-authority revision advances only
when the transaction starts in CodeMirror: user input, undo/redo, or a
programmatic editor/API edit. Final transaction annotations carry the exact
editor-origin document after all filters/extenders, including `filter: false`;
a later provider transaction in the same update cannot relabel that snapshot.
Reconciliation replaces an older deferred snapshot only when the same view,
CodeMirror identity, and binding epoch remain
present, this authority revision advances, and the latest editor-origin content
is exactly the one currently visible. Thus a plugin can legitimately change
`A -> B` without emitting a user-activity timestamp and `B` supersedes `A`
without conflict artifacts. A provider-rendered `A -> C` cannot claim that
lineage and remains conservative/preserved. If local `B` is followed by a
provider-rendered `C` before reconciliation samples the editor, the exact `B`
provenance is retained with `C`; a single superseded `A` is dropped instead of
creating a stale third candidate. The correction that rejects an editor-first
external reload also advances this narrow revision so the temporary external
document is not quarantined twice.

Deferred markers retain only primitive lineage fields, never MarkdownView,
EditorView, DOM, or CodeMirror document objects. A temporarily unresolved
CodeMirror is classified as unavailable rather than as a lineage rollback, so
the existing path-scoped user-activity fallback can still recapture a complete
visible document. A changed view identity, binding epoch, or resolved
CodeMirror identity remains incompatible and cannot use that fallback.

A create event has one additional narrow guard: if the live editor is already
ahead of the stable disk snapshot, the create import waits for the normal
editor/disk settle window instead of importing the stale snapshot.

## Last-Resort Escalation

If the narrow recent-typing shield still allows stale state to overwrite
active editing in production, the next escalation is file-scoped binding
withdrawal:

1. When a destructive patch targets a recently typed binding, detach the
   editor binding for that path.
2. Clear local cursor/awareness for that path while detached.
3. Keep the editor local until either the user idles, the file loses focus, or
   a manual/automatic reconciliation path can safely choose an authority.
4. Rebind only after editor content and Y.Text content are known to match, or
   after a conflict artifact has preserved the losing side.

This escalation is intentionally a last resort because it reduces live
collaboration quality and can hide remote cursor presence. It should not be the
default policy.

## Tests That Pin The Policy

The policy is covered by:

- `tests/editor-binding-recent-activity.ts`
  - destructive local repair patch is blocked during recent typing
  - provider-origin preserving patch is allowed
  - provider-origin destructive patch is always allowed
	- correlated external reload is cancelled before it reaches Y.Text
	- mixed LF/CRLF reloads use exact normalized content, while unrelated
	  same-size programmatic edits remain normal editor-origin changes
	- `filter: false` and a later filter that recreates a cancelled replacement
	  are reverted by exact post-update CAS and preserve the disk bytes once
	- delayed exact-content proof retains synchronous event ordering
	- user input during delayed proof remains authoritative without discarding
	  the proven external candidate
	- editor-first external reload uses exact disk-revision and state CAS rollback
	- a provider advance prevents rollback but cannot discard proven external bytes
	- out-of-order exact reads cannot replace a newer marker
	- a proof from before close/reopen cannot arm the replacement binding
  - a coarse-mtime plugin autosave cannot roll back the editor-origin change or
    poison the next programmatic editor edit
  - programmatic editor changes advance editor authority without advancing the
    user-activity timestamp; provider patches do not
  - pre-bind input and binding-epoch changes invalidate mutation tickets
- `tests/controller-authority-quarantine.ts`
  - a same-lineage programmatic successor replaces the deferred snapshot with
    no conflict note or durable quarantine
  - a provider-only editor revision cannot erase the captured candidate
  - `A -> B(local) -> C(provider)` retains exact `B` and `C` while dropping a
    single superseded `A`
  - temporarily missing CodeMirror state uses the activity fallback, and
    deferred markers retain no live editor/view/document references
- `tests/controller-recovery-orchestration.ts`
  - clean external/editor changes merge through a targeted Y.Text transaction
  - overlapping, missing-baseline, and ambiguous candidates are preserved
    without mutating the primary Y.Text
  - stale editor, provider, disk, lifecycle, and pane authorities replan with
    no stale artifact or baseline advancement
- `tests/disk-mirror-origin-classification.ts`
  - external reload rejection is a registered local origin
- `tests/trace-event-behavior.ts`
	- recent self-write fingerprint probing is exact and does not consume the
	  reconciliation suppressor
	- a same-size later disk revision cannot prove an older event was a self-write
- `tests/editor-binding-health-regressions.mjs`
  - filtering captures candidates but does not attempt a three-way merge
  - main routes every captured candidate to the canonical controller lane
  - destructive patch shielding depends on recent editor activity
  - patch capture does not store a live merge base
  - timing attribution cannot hide a suppression-window external write
- `tests/reconciliation-safety-brake.ts`
  - editor or CRDT changes after an authority decision abort the stale commit
- `tests/controller-recovery-orchestration.ts`
	- create events wait when the live editor is ahead of the disk snapshot
	- teardown/reset revokes in-flight startup and external-candidate authority

When changing this policy, update this document and those tests together.
