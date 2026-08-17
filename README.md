# KAOS

Real-time Obsidian vault sync that runs on infrastructure you own.

KAOS pairs an Obsidian plugin with a small Cloudflare Worker/Durable Object
server. Markdown and Obsidian Base (`.base`) documents stay as normal local
files, while text edits merge live
across devices through Yjs CRDTs. Attachments, snapshots, and deployment updates
are handled separately so the core editing path stays fast and understandable.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/adtstack/kaos/tree/main/server)
[![License: 0-BSD](https://img.shields.io/badge/license-0--BSD-green)](LICENSE)

## Lineage

KAOS began as a derivative of YAOS by Kavin Sood, released under the
[0BSD license](LICENSE). This repository keeps that license and acknowledges
the original work directly instead of presenting KAOS as a clean-room project.

The project has since diverged in name, product direction, documentation,
deployment and update flow, recovery tooling, QA harnesses, and Obsidian UX.
Even where the implementation has changed, the original project remains part of
KAOS's history.

## What KAOS Cares About

**Local files stay real.** Your vault remains a folder of Markdown and Base documents on
disk. KAOS syncs that folder instead of replacing it with a hosted database or a
new editor.

**Live text sync matters.** Markdown edits are represented as CRDT operations,
so two devices can edit the same note without falling back to conflicted-copy
workflows.

**The server belongs to you.** The sync room runs in your Cloudflare account.
KAOS is not a hosted note service, and it is not a replacement for Obsidian
Sync if you want a managed first-party product.

**Setup should not require ops work.** The normal path is deploy, claim,
install, connect. Advanced details are still inspectable, but they should not be
the first thing a user has to understand.

**Recovery is part of sync.** Snapshots, server receipts, diagnostics, and
bounded reset tools exist because sync systems fail in boring, real-world ways.
KAOS treats recovery as product surface, not as an afterthought.

**Limits should be explicit.** KAOS is for personal and small-team text-document
vaults. It is not trying to sync every Obsidian setting, every plugin database,
empty folders, or arbitrarily large text archives.

## Get Started

KAOS has two parts: the Obsidian plugin and the Cloudflare Worker server.

1. Click **Deploy to Cloudflare** above to create the Worker in your account.
2. Enter the one-time claim secret chosen during deployment and claim the server.
3. Install the KAOS Obsidian plugin.
4. Connect your vault from the claim page, setup link, or QR code.
5. Optional: add a Cloudflare R2 bucket for attachments and snapshots.

After pairing, Markdown and `.base` files begin syncing through the shared vault room.

## How It Works

1. Each Markdown or `.base` document receives a stable identity and a `Y.Text` CRDT.
2. Per-file CRDTs live inside one vault-level `Y.Doc`, so cross-file operations
   such as renames can be handled as one shared transaction.
3. Live editor edits flow through Yjs and CodeMirror.
4. Local disk changes from Obsidian, scripts, git, or agents are reconciled
   back into the shared CRDT state.
5. Each vault maps to a Durable Object sync room in the user's Cloudflare
   account.
6. Offline edits are queued locally and merged when the device reconnects.
7. Attachments sync through content-addressed R2 storage when configured.
8. Daily and on-demand snapshots provide a recovery path outside the live CRDT.

External changes to open notes merge automatically when edits do not overlap.
Overlapping or ambiguous edits never clobber the open editor: the editor
stays authoritative, the losing revision is recorded to the server audit log
(hashed path + content hash + reason), and the CRDT journal/snapshots, the
durable disk-index baseline, and git remain the recovery layer.

## Attachments and Snapshots

Markdown and `.base` sync work without R2. To sync images, PDFs, and other attachments,
configure an R2 bucket for the server.

R2 also enables daily automatic snapshots and manual point-in-time backups.
Snapshots can be browsed, compared with the current vault, and selectively
restored. Without R2, text sync still works, but attachment sync and snapshots
are disabled.

## Shared Exclude File

Put vault-wide sync exclusions in `SYSTEM/SETTING/kaos-exclude.md`. Add one
vault-relative file or folder prefix per line; blank lines and lines beginning
with `#` are ignored. KAOS syncs this control file itself so Obsidian and
headless devices apply the same policy, and reloads it while running.

Existing device-local `excludePatterns` values remain active for backward
compatibility, but new exclusions should be maintained only in the shared file.

## Guided Server Update

KAOS is designed to avoid terminal work, but the server still lives in your
Cloudflare account. Updates are handled through a GitHub Actions workflow in
the deployment repository so the same Worker identity, Durable Object bindings,
and state history are preserved.

1. One-time setup: initialize the updater from KAOS settings and commit the
   generated `.github/workflows/kaos-ops-v3.yml` workflow. The versioned name
   lets existing deployments add the migration-capable updater without
   replacing their older workflow. The bootstrap filename is immutable; normal
   server releases refresh the updater script automatically. If KAOS later needs
   a new bootstrap generation, it supplies the next filename and pre-fills the
   GitHub commit screen for a one-time commit.
2. Update: when KAOS reports a new server version, click **Update server** in
   KAOS settings. KAOS opens the GitHub workflow; run it with `update`, then
   KAOS watches the Worker until `/api/capabilities` reports the new version.
   If KAOS marks the release as migration-required, update the plugin first;
   sync intentionally pauses until the server is compatible. Take a current
   snapshot and review the release notes, then click **1. Create updater v3**
   in KAOS settings and commit the generated workflow. Next click
   **2. After commit, run migration** and explicitly enable
   `allow_migration_update` for that run. Leave it disabled for normal releases.
3. Roll back: run the same workflow with `revert`.

Publishing a new KAOS release does not automatically mutate the generated
deployment repo that Cloudflare created in your account. The guided update
workflow is the handoff that commits the new server artifact into that repo and
lets Cloudflare redeploy it.

Re-clicking Deploy to Cloudflare is not the safe update path for an existing
stateful server.

## Commands

KAOS commands are available from the Obsidian command palette.

| Command | Purpose |
| --- | --- |
| Open dashboard | Review sync health, conflicts, recovery, and actions |
| Reconnect to sync server | Reopen the live sync connection |
| Force reconcile vault with sync state | Re-merge local disk state with the CRDT |
| Show sync debug info | Inspect connection, queue, and file state |
| Copy debug info to clipboard | Copy the redacted diagnostic summary |
| Show recent sync events | Print the recent event timeline to the console |
| Show files needing attention | List preserved conflicts and guarded files |
| Export sync diagnostics (safe) | Export diagnostics without filenames |
| Export sync diagnostics with filenames | Export a local-private diagnostic bundle |
| Migrate sync schema to v2 | Run the explicit legacy schema migration |
| Import untracked files now | Admit eligible local documents into sync |
| Clear local server-receipt state | Reset this device's local receipt tracking |
| Reset local cache (re-sync from server) | Clear local IndexedDB state and re-sync |
| Take vault snapshot now | Create an immediate R2 snapshot |
| Browse and restore vault snapshots | Inspect, diff, and restore snapshot files |
| Create file history point | Save a file-level recovery point |
| Review file history | Browse and restore file history |
| Cleanup old vault snapshots | Apply snapshot retention cleanup |
| Check file history storage | Diagnose and repair history storage |
| Cleanup file history | Remove history entries using the configured policy |
| Nuclear reset | Wipe shared CRDT state and re-seed from disk |

## Engineering Notes

Selected public architecture notes live in `engineering/`. Useful starting
points:

- [Monolithic vault CRDT](./engineering/monolith.md)
- [Filesystem bridge](./engineering/filesystem-bridge.md)
- [Checkpoint and journal persistence](./engineering/checkpoint-journal.md)
- [Attachment sync](./engineering/attachment-sync.md)
- [Zero-config auth](./engineering/zero-config-auth.md)
- [Zero-ops update pipeline](./engineering/zero-ops-update-pipeline.md)
- [Local multi-device QA (no Cloudflare deploy)](./docs/testing/local-multidevice-qa.md)
- [Warts and limits](./engineering/warts-and-limits.md)

## Local Development

Install a local build into an Obsidian vault:

```bash
npm run install:plugin -- --vault "/path/to/your/vault"
```

Or target the plugin directory directly:

```bash
npm run install:plugin -- --plugin-dir "/path/to/your/vault/.obsidian/plugins/kaos"
```

The installer builds the plugin, copies the release files, and enables `kaos`
in `.obsidian/community-plugins.json`. Existing local plugin settings such as
`data.json` are preserved.

To copy files without enabling the plugin:

```bash
npm run install:plugin -- --vault "/path/to/your/vault" --no-enable
```

## Limits

KAOS currently treats Markdown text as the primary live sync surface.
Attachments sync separately through R2 when configured.

KAOS does not try to be a general `.obsidian` settings or plugin-state sync
engine. Empty folders are not synced because the CRDT tracks files and blob
references, not folder-only objects.

Avoid running KAOS against the same vault as another live file-sync engine such
as iCloud, Dropbox, Syncthing, or git auto-sync unless you understand the
interaction.

As a practical target, around 50 MB of raw Markdown text, excluding
attachments, is a comfortable ceiling for the current architecture.

## License

KAOS is distributed under the [0BSD license](LICENSE). The original copyright
notice is kept in the repository license file.

KAOS is an independent project and is not affiliated with Obsidian.
