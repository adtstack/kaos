# KAOS Conflict Semantics

## Overview

KAOS has four conflict classes, each with a defined policy. This document
is the single source of truth for conflict resolution behavior.

Live editor overwrite protection is intentionally narrower than general
conflict resolution. See
[`live-editor-authority-policy.md`](live-editor-authority-policy.md) for the
active rule: shield destructive non-user editor patches only during recent
local typing, never merely because a file is open, and never by performing a
string-level merge inside the editor binding. Open-file three-way planning is
owned by reconciliation and accepted targets enter through Y.Text.

## 1. Markdown divergence (no artifact preservation)

**Policy (1.12.0+):** KAOS does **not** write `(KAOS conflict ...)` files for
markdown and never rewinds an open editor from a disk snapshot. Every losing
revision is recorded through `recordDiscardedRevision` — a local trace
(`revision-discarded` / `conflict-revision-discarded`) and a durable server
audit record (`POST /vault/:id/trace`, event `revision.discarded`) that
carries a hashed path, the sha256 content hash, and the policy reason.

**Recovery layer (what replaces artifacts):**

- **CRDT merge** — real two-device concurrent edits merge at the character
  level in Yjs; the server persists the update journal and snapshots.
- **Disk-index baseline** — the last clean-settlement content hash per path
  (carried forward unchanged for deferred paths, never dropped).
- **git / server snapshots** — durable history outside the plugin.
- **Blob conflict artifacts** — unchanged (see §2); binaries have no CRDT
  history, so files remain the only recovery surface there.

**Who wins:** the single provable authority — the visible editor (converged
into CRDT via `ORIGIN_DISK_SYNC_RECOVER_BOUND`), or the disk/CRDT winner of a
closed-file three-way decision. No authority is selected when the editor
authority is unresolvable (multiple panes, a read failure, or no readable
pane): every replica is left untouched and the next vault event re-evaluates
(trace `visible-authority-unresolved-deferred`).

**Editor rollback is abolished:** the editor document is never rewritten
backward — not by an external-reload revert
(`ORIGIN_EDITOR_EXTERNAL_RELOAD_REJECT` is gone), not by the open-file idle
disk recovery (`ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER` application is gone), and
not by a filter-bypass Y.Text projection. A disk change on an open note is
ingested only by the open-external-edit merge lane (editor idle >= 3s, editor
== CRDT, baseline-based 3-way merge) or after the note closes.

### Open external-edit reconciliation

An external disk write to an open Markdown note is not a separate conflict
class and does not make disk authoritative. The binding intercepts only the
correlated whole-document reload and hands the exact candidate to
`ReconciliationController`, which compares:

- `B`: the exact durable baseline body;
- `L`: the single current editor authority, which must agree with current
  Y.Text;
- `D`: the stable external disk candidate.

The selected target is applied in one targeted Y.Text transaction when only
one side changed or both changed in non-overlapping hunks. Same or adjacent
hunks, a missing baseline, multiple pane authorities, editor read failure, or
frontmatter rejection cause no partial primary-file mutation — the current
Y.Text remains primary and the external candidate is recorded as a discarded
revision. Stale calculations replan without recording anything merely because
authority advanced.

### Superseded external revisions (audit instead of preserve)

Distinct raw disk revisions that an async read proves were superseded by a
newer event are recorded as discarded revisions (trace + server audit), never
written to files. One provably redundant class is not even audited: bytes
that hash to the durable disk-index `contentHash` are the baseline itself
(trace `superseded-external-revision-baseline-skipped`). The candidate
tracking/FIFO remains — it gates dirty-path admission and open-flush leases —
but the drain only records and retires.

## 2. Blob download conflict

**Trigger:** During blob download, either:
- The target file was modified locally between download start and write
  (`existing-changed-during-download`)
- A create race: file was created locally while download was in flight
  and content differs (`create-race-mismatch`)

**Policy:**

1. Write the remote bytes as a local-only conflict artifact:
   `<base> (KAOS remote conflict <timestamp>).<ext>`
2. Preserve the local version at the original path.
3. Mark the conflict artifact as local-only and suppress the immediate
   vault event from upload.
4. Show a Notice to the user.
5. Increment `_blobConflictArtifacts` counter (visible in debug snapshot).

**Who wins:** Neither side is selected automatically. The local version stays
at the original path and the remote version remains a local-only artifact until
the user makes an explicit choice in Dashboard → Conflicts.

**Manual resolution:** Every active blob conflict row shows two distinct
actions:

- **Keep local original** publishes the exact reviewed local bytes as a causal
  successor of the exact remote ref. The marker and remote artifact remain
  until the guarded upload and durable settlement complete.
- **Use remote copy** installs the exact reviewed remote artifact at the
  canonical path without rewriting the remote ref. The displaced local file is
  retained as a visible `KAOS local backup` safety copy.

Both actions are bound to the conflict episode, original/artifact file
identities, full remote ref, and CRDT source version. A changed file or stale
remote episode disables or rejects the action without selecting either side.
Ordinary file modify events do not clear this conflict marker or queue an
implicit upload.

**Sync behavior:** Blob conflict artifacts are **local-only**. They are
skipped by upload/reconcile paths using both the session-local guard and
the `"(KAOS remote conflict "` filename marker, so the local-only policy
survives plugin restart. Markdown conflict artifacts follow the same
local-only policy through create-event suppression and their durable filename
marker.

**Rationale:** Binary conflict artifacts may be large (images, PDFs) and
uploading them could create confusion on other devices. The local device
that experienced the conflict is responsible for resolving it.

### Attachment rollback safety copies are not conflicts

A causally proven clean remote replacement or remote deletion may move the
exact previous `TFile` to
`<base> (KAOS local backup <timestamp> <operation-id>).<ext>` before changing
the canonical path. This is a no-clobber rollback copy required because the
Vault API does not provide an atomic binary replace operation. It remains
local-only and visible for manual review, but it is tracked and displayed
separately from true `KAOS remote conflict` artifacts and does not increment
the blob conflict counter.

## 3. Remote delete conflict (local-dirty preservation)

**Trigger:** A remote tombstone arrives for a file that exists locally.

### Three-way decision model

Remote delete uses a typed three-way decision, NOT a boolean dirty flag.
This prevents conflating "known dirty" with "unknown baseline":

```
apply-delete:        baseline known, local file matches → trash/delete
preserve-revive:     baseline known, local file differs → preserve + revive tombstone
preserve-unresolved: baseline unknown (CRDT/hash unavailable) → preserve, do NOT revive
```

### Markdown (DiskMirror)

**Detection:** Compare disk content against `ytext.toString()`.

| Baseline state | Local state | Decision |
|---------------|-------------|----------|
| Known (CRDT text available) | Disk matches CRDT | `apply-delete` |
| Known (CRDT text available) | Disk differs from CRDT | `preserve-revive` |
| Unknown (CRDT text null) | File exists | `preserve-unresolved` |

**`preserve-revive` policy:**
1. Preserve the local file on disk.
2. Revive the CRDT tombstone via `ensureFile(path, diskContent, device,
   { reviveTombstone: true })`.
3. File re-enters sync normally on the next reconcile.
4. **This is intentional resurrection:** local dirty work wins over
   remote delete. The file will sync back to other devices.

**`preserve-unresolved` policy:**
1. Preserve the local file on disk.
2. **DO NOT revive tombstone.** Tombstone remains in CRDT.
3. Path recorded in `preservedUnresolvedPaths`; ordinary reconcile/import
   passes skip it instead of auto-reviving.
4. Explicit user action or a future remote event is required to resolve the
   limbo state.
5. This prevents phantom resurrection when CRDT state is transiently
   unavailable (startup, reconnect, hydration race).

**Read failure policy:** If `vault.read()` fails (file locked, busy,
permission denied) when a CRDT baseline IS available, the decision is
`preserve-unresolved` — NOT `apply-delete`. Rationale: inability to
verify is not proof of cleanliness.

### Multi-pass resurrection guard (`preservedUnresolvedPaths`)

The immediate `handleRemoteDelete` handler is not the only code path that
could resurrect a tombstoned file. Later scan/import passes also see
"local file exists + CRDT tombstoned" and might auto-revive.

To prevent this, both `DiskMirror` and `BlobSyncManager` maintain a
`preservedUnresolvedPaths: Set<string>` that records every path where
`preserve-unresolved` was the decision.

**Unknown-baseline preserved files are NOT automatically revived.**

Guarded code paths:
- `importUntrackedFiles()`: skips paths in `preservedUnresolvedPaths`
- `BlobSyncManager.reconcile()`: skips preserved-unresolved paths
  (same as tombstone check)
- `BlobSyncManager.processUpload()`: aborts upload for preserved-unresolved
  paths (guards against stale queue snapshots)

**Clearing conditions** (user intent established):
- User explicitly modifies the file (vault `modify` event, non-suppressed)
- User creates a new file at that path (vault `create` event)
- User deletes the file locally
- A future remote-delete arrives with a real baseline (handled with
  evidence instead of blindness)

The marker is NOT cleared by:
- Reconcile scans seeing the file
- Queue snapshot restoration
- Plugin restart (set is session-local; tombstone itself persists in CRDT
  and provides the durable guard across sessions)

### Blobs (BlobSyncManager)

**Detection:** Compare local file's cached hash against `knownHash`.

| knownHash state | Local hash | Decision |
|----------------|-----------|----------|
| Known, matching | Same | `apply-delete` |
| Known, mismatching | Different | `preserve-revive` |
| Null (no known baseline) | File exists | `preserve-unresolved` |

**`preserve-revive` policy:**
1. Preserve the local file on disk.
2. Clear the blob tombstone so the file re-enters sync.
3. Next reconcile treats it as a normal disk blob (upload if needed).

**`preserve-unresolved` policy:**
1. Preserve the local file on disk.
2. **DO NOT clear blob tombstone.**
3. Path recorded in `preservedUnresolvedPaths` — blocks `reconcile()`
   upload scan, `handleFileChange()` is not blocked (it represents
   intentional user action and clears the guard instead).
4. This is a conservative limbo state. It is not auto-re-evaluated by
   ordinary reconcile/import passes; explicit user action or a future
   remote event resolves it.

**Stat failure policy:** If `adapter.stat()` fails (file locked, busy)
when a known hash IS available, the decision is `preserve-unresolved` —
NOT `apply-delete`. Same rationale as Markdown: inability to verify is
not proof of cleanliness.

### Important product consequence

> Remote delete does NOT win over locally modified content when the
> baseline is known. KAOS preserves and revives the local version.
> This means deleted files CAN come back if they were locally modified.
> This is intentional and documented behavior.

When baseline is unknown, KAOS preserves locally but does NOT resurrect.
This prevents "deleted folders coming back" from transient CRDT
unavailability.

## 4. Safety brake (blocked remote overwrites)

**Trigger:** Reconcile would overwrite >20 local files AND >25% of the
vault. This indicates a possible bulk corruption from a remote device.

**Policy:**
1. Block all remote-to-disk overwrites for this reconcile pass.
2. Allow additive creates (new files from CRDT that don't exist on disk).
3. Blocked paths are **excluded from disk index advancement** so they
   remain dirty and are re-evaluated on the next reconcile.
4. `blockedDivergenceCount`, `lastBlockedDivergenceAt`, and a sample of
   blocked paths are exposed in diagnostics state.
5. A Notice is shown to the user.

**Resolution:** The blocked state resolves when either:
- A subsequent reconcile is below the safety threshold, OR
- The user manually triggers a full reconcile, OR
- The user exports diagnostics and inspects the divergence.

`lastBlockedDivergenceAt` is historical and persists even when count
resets to 0. UI/status must treat count as current and timestamp as
"last time this happened."

## Naming conventions

Blob conflict artifacts cap component lengths to prevent filesystem path
length issues (255-byte component limit):
- Device name: max 50 characters
- Base name: max 100 characters (further reduced if suffix is long)
- Illegal filesystem characters are replaced with `-`

Legacy markdown `(KAOS conflict ...)` files from releases before 1.12.0 are
still recognized and excluded from markdown sync classification (they never
seed CRDT), but no new markdown artifacts are created.

## Recovery quarantine

Not a conflict policy per se, but related: if the same recovery
fingerprint (reason + content hashes) recurs 3 times within a 10-minute
window, the path is quarantined to prevent infinite recovery loops. The
guard applies to the remaining disk→CRDT recovery lane (bound-file
local-only divergence, editor == disk ≠ CRDT alignment), which is the only
open-editor recovery that cannot jump the editor backward.

- Same fingerprint within TTL: count increments
- Same fingerprint beyond TTL: count resets to 1
- Different fingerprint: count resets to 1
- Map capped at 200 entries (LRU eviction)
- Session-local only (plugin restart clears)

`contentFingerprint()` is FNV-1a 32-bit + length. It is NOT cryptographic
and NOT a content identity primitive. It is a cheap loop coalescing key.

### Limitations and release-note wording

Recovery quarantine is **session-local only**. Restarting the plugin
clears all fingerprint state. This means:

- A pathological recovery loop that only fires once per plugin session
  will not be quarantined.
- The guard detects tight loops (3x same fingerprint in <10 minutes),
  not slow-motion drift.

**Correct release wording:**
> Repeated identical recovery attempts are detected and suppressed
> within a plugin session.

**Incorrect / overclaiming wording:**
> Recovery loops are fixed forever.
> KAOS guarantees no repeated recovery.

The quarantine is a practical safety net, not a correctness proof.
