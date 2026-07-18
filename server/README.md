# KAOS server

Cloudflare Worker / Durable Object backend for the KAOS Obsidian plugin. It relays
Yjs CRDT updates, optionally stores attachments in R2, and stores snapshots when R2
is configured.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/adtstack/kaos/tree/main/server)

## What this server does

- One vault maps to one Durable Object-backed sync room.
- Yjs sync runs through `y-partyserver`.
- Durable Object storage persists the live CRDT snapshot.
- Attachments are uploaded through the Worker and stored in R2.
- Snapshots are gzipped CRDT archives stored in R2.
- Auth uses the claimed setup token by default, with `SYNC_TOKEN` as an optional hard override.

## Standard deploy

Use the **Deploy to Cloudflare** button above for the default setup. It targets the `server/` subdirectory so Cloudflare treats this folder as the project root.
This repo intentionally keeps `.env.example` free of assignments so the deploy flow does not prompt for `SYNC_TOKEN` by default.

The local `wrangler.toml` in this directory defines:

- the Worker entrypoint (`server/src/index.ts`)
- the `VaultSyncServer` Durable Object binding
- the `ServerConfig` Durable Object binding

The default deploy is text-only:

- no `SYNC_TOKEN` secret is required up front
- no R2 binding is required up front
- the first browser visit shows the claim page

That claim page generates a token in the browser and returns an `obsidian://kaos?...` setup link you can use to configure the plugin.

## Guided server update for an existing deploy

The Deploy to Cloudflare button creates a new repository in your own Git account and connects this Worker to that new repo.

That means future pushes to your generated repo will redeploy automatically, but future pushes to the original `adtstack/kaos` template repo will not update your existing Worker on their own.

To pick up new KAOS changes later:

1. Add your generated repo URL in the plugin settings (`Deployment repo URL`).
2. Use **Initialize updater** once (GitHub) if workflows are missing.
3. Use **Update server** from plugin settings. KAOS opens the GitHub workflow.
4. Run the workflow with `update`; KAOS watches `/api/capabilities` until the
   Worker reports the new server version.
5. Cloudflare redeploys automatically after the workflow push.

The Deploy to Cloudflare button is still the first-install path. Do not use it
as the update path for an existing stateful Worker.

Server updates are published through the main KAOS GitHub release stream. The
release workflow validates plugin, server, and schema compatibility before it
publishes the update manifest and server artifact.

## Optional R2 setup

If you want attachments and snapshots later:

1. Create an R2 bucket in the Cloudflare dashboard.
2. Open your Worker in **Workers & Pages**.
3. Add an R2 binding named `KAOS_BUCKET`.

The same Worker will then begin reporting attachments and snapshots as available.

On later `npm run deploy` runs, KAOS checks the currently deployed Worker before
deploying. If that Worker already has an R2 binding named `KAOS_BUCKET`, the
deploy script adds the matching `[[r2_buckets]]` block to `wrangler.toml`
automatically so Wrangler keeps the binding during the redeploy.

For a first deploy where the Worker does not exist yet, you can preselect a
bucket without editing TOML by setting `KAOS_R2_BUCKET_NAME` before running
`npm run deploy`.

If the Cloudflare dashboard UI is transiently failing when attaching the bucket, use this fallback in your generated deploy repo:

1. Edit `wrangler.toml`.
2. Add this block (replace bucket name):

```toml
[[r2_buckets]]
binding = "KAOS_BUCKET"
bucket_name = "your-bucket-name"
```

3. Commit and push. Cloudflare redeploys from that commit.

After deploy, refresh your Worker URL. KAOS should report attachments/snapshots as available.

## Local development

```bash
cd server
npm install
npm run dev -- --var SYNC_TOKEN:dev-sync-token
```

The local Worker will be served by Wrangler. Use its printed local URL as the plugin's **Server host**.

Passing `SYNC_TOKEN` locally is optional. If you omit it, the server starts unclaimed and you can claim it in a browser.

## Manual deploy

```bash
cd server
npm install
npm run deploy
```

`npm run deploy` runs `scripts/auto-bind-r2.mjs` first. If no existing
`KAOS_BUCKET` binding or explicit `KAOS_R2_BUCKET_NAME` is found, it leaves the
deployment text-only and continues.

## Cloudflare deployment quirks

Cloudflare can occasionally show temporary dashboard/build instability. Common examples:

- build queue delays, then the deploy eventually succeeds
- temporary dashboard failure when adding an R2 binding

Recommended workflow:

1. Retry once after a short wait.
2. If it still fails, use repo-backed fallback paths (like `wrangler.toml` binding edits) and push a new commit.
3. Capture the failed deployment commit SHA from Cloudflare (**Workers & Pages** → deployment → **Commit**) when opening an issue.

The commit SHA lets us verify the exact server snapshot Cloudflare built, which is critical for debugging intermittent failures.

## Endpoints

### WebSocket sync

- `wss://<host>/vault/sync/<vaultId>?token=<setup-token>`

### Blob APIs

- `POST /vault/<vaultId>/blobs/exists`
- `PUT /vault/<vaultId>/blobs/<sha256>`
- `GET /vault/<vaultId>/blobs/<sha256>`

### Snapshot APIs

- `POST /vault/<vaultId>/snapshots/maybe`
- `POST /vault/<vaultId>/snapshots`
- `GET /vault/<vaultId>/snapshots`
- `GET /vault/<vaultId>/snapshots/<snapshotId>`

### Debug

- `GET /vault/<vaultId>/debug/recent`

All HTTP endpoints require `Authorization: Bearer <setup-token>` once the server has been claimed.

If you set `SYNC_TOKEN`, that environment value becomes the required token instead.

## Operational safeguards

- Blob uploads are capped at 10 MB by default.
- Blob existence checks use bounded concurrency.
- Snapshot creation is daily-idempotent through the `/snapshots/maybe` route.
- Snapshot archives are stored compressed to keep R2 usage modest.
- Worker, Durable Object, storage, timer, and retry changes must follow the
  [Durable Object cost guardrails](../docs/engineering/durable-object-cost-guardrails.md).
  Run `npm run guard:do-cost` before committing those changes.
