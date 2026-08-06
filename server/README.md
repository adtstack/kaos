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
- The one-time claim is protected by a separate deploy-time `KAOS_CLAIM_SECRET`.

## Standard deploy

Use the **Deploy to Cloudflare** button above for the default setup. It targets the `server/` subdirectory so Cloudflare treats this folder as the project root.
The deploy flow reads `.env.example` and prompts for `KAOS_CLAIM_SECRET`. Choose
a unique random value of 32–512 visible ASCII characters without spaces and
keep it until the first claim succeeds. This secret only proves ownership of the fresh deployment; it
is not the sync token and is never included in a setup link.

The local `wrangler.toml` in this directory defines:

- the Worker entrypoint (`server/src/index.ts`)
- the `VaultSyncServer` Durable Object binding
- the `ServerConfig` Durable Object binding

The default deploy is text-only:

- no `SYNC_TOKEN` secret is required up front
- `KAOS_CLAIM_SECRET` is required to authorize the one-time claim
- no R2 binding is required up front
- the first browser visit shows the claim page

On first visit, enter the same `KAOS_CLAIM_SECRET` you chose during deployment.
The claim page then generates a different sync token in the browser and returns
an `obsidian://kaos?...` setup link. The claim secret is sent only in the
same-origin claim request header and is never returned, logged, or embedded in
the link.

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
npm run dev -- --var KAOS_CLAIM_SECRET:local-claim-secret-at-least-32-chars
```

The local Worker will be served by Wrangler. Use its printed local URL as the plugin's **Server host**.

Passing `SYNC_TOKEN` locally is optional. If you set it, the server starts in
the explicit environment-token mode and does not use the claim flow. If you
omit it, provide `KAOS_CLAIM_SECRET` as shown above, then enter that value in
the browser to claim the server.

For the canonical same-machine and LAN multi-device procedure, including
Wrangler bind options, isolated persistence, QA vault setup, and plaintext-HTTP
limits, see [Local Multi-Device QA](../docs/testing/local-multidevice-qa.md).

## Manual deploy

```bash
cd server
npm install
npx wrangler secret put KAOS_CLAIM_SECRET
npm run deploy
```

Use a unique value of at least 32 characters. Do not store its value in
`wrangler.toml` or reuse the sync token. An unclaimed server without a valid
`KAOS_CLAIM_SECRET` fails closed and will not accept `/claim` requests.

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

- Obtain a short-lived ticket with `POST /vault/<vaultId>/auth/ticket`.
- Connect to `wss://<host>/vault/sync/<vaultId>?ticket=<short-lived-ticket>`.
- Legacy `?token=<setup-token>` remains available only for older plugin clients
  during the migration window and can be disabled with
  `KAOS_DISABLE_LEGACY_WS_TOKEN`.

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
