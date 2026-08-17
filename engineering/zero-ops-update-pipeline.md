# RFC: Zero-Ops Update Pipeline for Detached Cloudflare Forks

Status: Implemented  
Owner: KAOS
Scope: Server update lifecycle for Deploy-to-Cloudflare KAOS servers

## Problem: the Day 2 trap

KAOS uses Cloudflare's Deploy button to optimize for a 60-second setup. That flow works well for onboarding, but creates a lifecycle problem:

1. The deploy flow creates a detached user repository.
2. Cloudflare strips `.github/workflows` during clone.
3. Without workflows, users have no update pipeline in their generated repo.

For a stateful Durable Object + SQLite backend, this is a critical Day 2 issue, not just DX polish.

## Constraints

The update path must preserve consumer-grade UX while protecting user data:

- No terminal requirement.
- No PAT/OAuth token setup in the plugin.
- No server self-mutation via Cloudflare API credentials.
- No dependence on re-clicking Deploy as an update primitive.
- Must preserve existing Worker identity and DO bindings.

## Architecture

### Phase 1: Day 1 install

Users install via Deploy to Cloudflare. We keep this path because onboarding speed matters.

### Phase 2: bootstrap the updater once

Because workflows are stripped during deploy clone, KAOS bootstraps them using a GitHub deep-link:

- Plugin collects the generated repo URL.
- Plugin opens a pre-filled GitHub file creation URL for
  `.github/workflows/kaos-ops-v3.yml`.
- User clicks **Commit changes** once.

The versioned filename also gives existing deployments a collision-free path
to add the migration-capable workflow while retaining their older
`kaos-ops.yml`.

This gives the repo an update entrypoint without terminal or PAT setup.

### Phase 3: repo-local execution

`kaos-ops-v3.yml` is generated as a self-contained dispatch workflow inside the
deployment repo:

- update action: pull release artifact and apply
- revert action: revert last update commit

Keeping execution repo-local avoids an extra private-repo workflow-sharing step.
The updater logic still ships in the server artifact itself, so normal updates
can replace the local updater script when needed. For deployment repositories
that predate that script, v3 refreshes the updater from the selected release ZIP
before each update run.

### Control-plane ownership

`kaos-ops-v3.yml` is the one managed control-plane file. Every server artifact
contains its current template, and the updater replaces that exact file in the
same commit as the server code. The workflow run that makes the commit continues
with its prior definition; the refreshed definition applies on the next run.

All other `.github/**` paths are user-owned and are always protected. `wrangler.toml`
is user-owned as well. Normal releases must keep the v3 filename; a new vN file
is allowed only when the existing workflow cannot recover or execute the required
bootstrap path.

## Update mechanism

KAOS updates the server by applying a release artifact (`kaos-server.zip`) into the generated deployment repo, committing, and pushing. Cloudflare redeploys from that commit.

This avoids upstream monorepo merge complexity and keeps rollback straightforward.

For private release repositories, the workflow passes `KAOS_RELEASE_TOKEN` to
the updater. That token needs GitHub Contents: read access to the release repo.

## Safety valves

### 1) Migration gate (explicit opt-in)

Updater reads `kaos-server-manifest.json`. If `migrationRequired: true`, the
update stops before changing files unless the operator explicitly enables the
workflow's `allow_migration_update` input. That confirmation is passed to the
updater as `KAOS_ALLOW_MIGRATION_UPDATE=true`; the default remains fail-closed.
For an incompatible schema release, the plugin is updated first and pauses sync
until the v2 workflow updates the server. This order ensures the operator has
the migration-capable workflow before the old server updater is invoked.

### 2) Wrangler drift warning

Updater compares release `wrangler.toml` expectations against local config and warns when required bindings/vars are missing.

### 3) Schema compatibility preflight

Release artifacts include the server schema range they support. The updater
compares that range with the currently deployed server before applying files.
If there is no overlap, the update aborts unless the release is explicitly
marked migration-required or the operator intentionally bypasses the guard.

### 4) Runtime compatibility guard

Server exposes compatibility metadata via `/api/capabilities`. Plugin blocks only incompatible combinations. Legacy/missing version metadata does not hard-block sync.

## Metadata ownership and multi-device safety

Updater metadata (`updateRepoUrl`, `updateRepoBranch`, provider) is persisted server-side and synchronized safely:

- Plugin does not push empty metadata.
- Server update-metadata writes use patch semantics (null does not clear existing metadata).
- New devices hydrate local settings from server capabilities.

This prevents "fresh device wipes updater config" regressions.

## Why not re-click Deploy?

Deploy is an install primitive, not an in-place update primitive. Re-deploy can create a new project path and risks orphaning user state if misused. KAOS update execution therefore happens at the Git layer.

## User-facing behavior summary

- One-time: initialize updater from plugin settings.
- Normal update: click **Update server** in KAOS settings, run the opened workflow with `update`, then let KAOS watch the Worker version.
- Rollback: run workflow with `revert`.
- Migration-required release: update the plugin first (sync pauses), review the
  release notes and take a current snapshot, create and commit updater v3, then
  explicitly enable `allow_migration_update` for that workflow run. Without the
  opt-in, the workflow fails safely before changing files.
