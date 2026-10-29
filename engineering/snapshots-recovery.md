# Snapshot Semantics and The Recovery Model

Sync is nice. Recovery is the real reason you self-host your data.

Obsidian's local File Recovery plugin is excellent for small "oops" moments (like accidentally deleting a paragraph). KAOS does not try to replace it. KAOS snapshots are designed for catastrophic recovery: *"I accidentally wiped my folder structure and need to intelligently restore the vault to yesterday's state."*

Snapshots are the operational safety-net for the CRDT graph, not a second attachment transport. KAOS serializes the full `Y.Doc` state, gzips the payload, and writes two objects to R2:
- `crdt.bin.gz` (the compressed CRDT state)
- `index.json` (snapshot metadata and blob references)

## Deduplication by design

*Snapshot creation does not duplicate blob bytes.*

If snapshots copied full binary payloads each time, a daily snapshot would explode storage costs for vaults with large static media. Instead, the index.json acts as a point-in-time manifest. It records the content hashes currently referenced by the CRDT (pathToBlob). Because R2 attachments are content-addressed, this provides inherent deduplication.

At restore time, the CRDT state is authoritative. The plugin applies the restored graph, reconstructing the exact folder structure and text, and then reconciles attachment files by pulling the missing hash pointers from R2.

## Safety Invariants

A few invariants keep this model correct under failure:
- Snapshot IDs are generated using cryptographic randomness, not predictable Math.random() calls.
- Snapshot operations share the exact same storage substrate as blob sync. If R2 is unbound, snapshots are disabled entirely (`snapshots: false`), preventing ambiguous recovery guarantees.
- Missing blob objects during restore are surfaced as localized data gaps, not silent structural failures.

The result is a system where text collaboration remains real-time and cheap, attachment sync remains content-addressed, and snapshots provide deterministic vault recovery without introducing a second complex storage engine.


## Match one local file to the server

Choose **KAOS: Restore from server** in a file menu, or **Restore file from
server (active file)**. This reads the selected file directly from the server
over authenticated HTTP. The server copy is the chosen source regardless of
which device has newer edits. A successful WebSocket sync is not required;
the local sync runtime, device authentication, and HTTP server must be available.
Attachment repair also requires an initialized attachment manager and its R2
object. Older servers without the file-repair endpoint require an update.

Markdown and `.base` contents, attachment bytes, and the local CRDT state must
match the selected server version before success is reported. Open Markdown
editors are backed up and refreshed. Close canvas/attachment views and Bases
views that do not expose an editor before retrying: their unsaved state cannot
be safely read or replaced through the public API. Files excluded from sync are
rejected. Missing or deleted server files are reported without deleting local files.

The provider pauses socket and broadcast exchange during repair. To handle
unsent edits correctly, the server merges the whole pending replica and corrects
the selected target in an isolated Yjs document, then publishes one atomic
update. Peers never observe the discarded target contents as an intermediate
version. Other pending file edits are preserved and synchronize in that batch.
This is not a historical snapshot restore.

The selection token fingerprints the entire server CRDT state. Any server
document change can expire the review, even a change to another file. Reopen
the command to review again. Server state, local update, and returned update
have an 8 MiB limit measured as uncompressed Yjs data; larger rooms are rejected.
The read response contains only the selected file descriptor, while the commit
exchanges whole CRDT updates because Yjs client clocks span multiple files.

Before any commit, safety copies and a durable operation record are written to
`<settings-dir>/plugins/kaos/restore-backups/server-file-repair/<operation>/`:

- `original.bin`: verified pre-repair disk bytes.
- `local-crdt.bin` and `local-text.json`: local CRDT and open text editor copies.
- `server.json`: selected server version; `server-crdt.bin`: returned committed state.
- `record.json`: recovery phase, hashed server/vault/device scope, and prior connection intent.

Attachments also use the existing visible `(KAOS local backup ...)` safety-copy
convention. Both forms remain outside normal KAOS synchronization. Keep backups
until the repair has been checked. They contain file content and are not an
automatic backup-retention policy.

Input changes, path replacement, scope changes, and hash mismatch stop the
operation instead of overwriting new work. If failure occurs after a commit may
have been sent, regular sync remains paused across restart. Retry **Restore
from server** for that file before restoring another file. A verified successful
retry completes older records and resumes the saved connection intent. Do not
delete an unfinished record to bypass the pause: a rejected or unanswered commit
may leave unsent edits that would otherwise be uploaded on reconnect.

Records are scoped to the installation's IndexedDB device identity, not a
possibly replicated plugin setting. Another device cannot resume an operation
from copied records. On restart, an absent canonical path can be reconstructed
from verified `original.bin` bytes; an occupied path is never overwritten for
this fallback. Malformed records or unverifiable backups block startup for inspection.

## Full-vault point-in-time restore

Choose **Browse and restore vault snapshots**, review the diff, then select
**Restore entire vault to this snapshot**. This restores changed files,
undeletes historical files, restores attachment references, and tombstones
paths created since the snapshot. Selective restore keeps its existing behavior.
Only synchronized vault content is included; local-only files, plugin settings,
and safety copies are outside the snapshot graph.

The confirmation shows changed, deleted, and created-to-remove counts. More
than 200 affected files or more than 50 removals requires typing `restore`.
A required automatic pre-restore R2 snapshot must succeed before the operation
continues. Offline state, unavailable R2, server failure, or an unconfirmed
snapshot aborts without changing live CRDT or primary files.

Pre-restore local bytes for both changed and removed files, including attachments,
are saved under `.obsidian/plugins/kaos/restore-backups/<timestamp>/` (using the
vault's configured settings directory). Hidden backups use the vault adapter
and stay outside sync. Missing files have no local bytes to back up. A backup
failure aborts before commit.

CRDT identities/content, attachment refs/tombstones, disk identities/revisions and
bytes, open editor identities/contents, and the reviewed operation's path sets
must remain current across the full restore/removal union. New changes during
review require reopening the diff. Historical file IDs active under a different
path reject the entire operation instead of deleting a renamed live file.

Created Markdown files move to Obsidian trash after backup. Their delete echoes
are suppressed and open bindings are detached. Created attachments are handled
by the existing blob tombstone observer and preserved as visible
`(KAOS local backup ...)` files. Restored attachments download through ordinary
blob sync. Attachment settlement can continue after the Markdown operation has
been applied; missing objects or local-dirty conflicts remain visible sync gaps.

A Markdown write/trash failure after CRDT commit records
`restore-disk-settlement-failed` in Attention and reports an incomplete restore;
it does not report success or overwrite newer disk work to compensate.
Diagnostics emit `recovery.restore.full.started`, `.completed`, or `.failed` with
category counts and elapsed time, without raw note paths.

Concurrent remote edits still merge under Yjs soft-restore semantics. For other
devices' projection, local-dirty preservation, and reconnect safety-brake behavior,
see [Conflict semantics](conflict-semantics.md#full-snapshot-restore-on-other-devices).
