# Conflict review and full-vault restore validation

Date: 2026-09-30
Plan: [Conflict review UI and full-vault restore](../superpowers/plans/2026-09-30-conflict-review-ui-and-full-vault-restore.md)

## Delivered scope

Tasks 1–8 are implemented locally. Attention offers local/remote content review,
baseline-based three-way or two-way manual merge, and episode/content-fenced
merged application. Full-vault restore includes restore, undelete, created-since
removal, mandatory safety snapshot, exact local Markdown/attachment backups,
authority checks across the operation union, delete suppression/unbinding,
post-commit settlement quarantine, confirmation thresholds, telemetry, and docs.
No commits, push, plugin installation, or deployment were performed.

Existing keep-local/use-remote controller branches were compared with HEAD and
are byte-identical. DiskMirror adds only the public removal wrapper; editor
bindings, BlobSync, and the safety-brake policy are unchanged. Selective restore
retains its existing transaction origin and default behavior. Existing tests
retain their assertions; additions use fixture parameters with original defaults.

## Adjustments based on repository evidence

1. **Merged application uses the existing live Y.Text.** The repository's
   `ensure-file-writer-allowlist` permits exactly nine certified writer owners.
   Adding another `ensureFile` writer would break that unchanged release guard.
   A content review already identifies a live conflict text, so the merged lane
   requires that exact live Y.Text and applies its targeted diff directly under
   the existing operation ID and `ORIGIN_DISK_SYNC`. It does not create or revive
   a missing CRDT note. Reviewed local/remote bytes are also passed to the new
   lane to reject content movement while the review was open.
2. **Force reconcile does not bypass the brake.** Both Dashboard's action and
   `kaos:force-reconcile` use the existing reconciliation entry point, which
   evaluates the same >20-file AND >25% brake. The plan's automatic bulk-accept
   runbook assumption was corrected in conflict semantics. No bypass marker,
   override, sync-protocol change, or existing controller-policy change was added.
3. **Hidden safety backups use the vault adapter.** The configured Obsidian
   directory is not represented reliably in vault file metadata. Full restore
   creates missing parent directories through the adapter and writes reviewed
   Markdown and binary bytes there without generating primary-vault events.
   Existing selective/history backup paths are unchanged.
4. **Full-restore authority checks reuse one Markdown path index.** The new
   full-restore-only helper avoids rebuilding it for every affected file. The
   synthetic 2,000-file review capture improved from 11,698 ms to 229 ms in this
   environment. A preparation Notice appears if capture takes more than 3 seconds.

## Validation

| Check | Result | Evidence / scope |
| --- | --- | --- |
| Controller RED | PASS | Before merged implementation: 68 assertions passed, 21 failed |
| Removal primitive RED | PASS | Before removal implementation: 28 new assertions failed |
| Full service RED | PASS | New orchestration test rejected missing review/service method |
| Full regression command | PASS | `env -u KAOS_PLUGIN_DIR npm run test:regressions`: 185 suites passed, 0 failed |
| Final review/controller slice | PASS | Re-run after final modal wording/fixture cleanup; merged controller: 93 assertions passed |
| Build | PASS | `npm run build`: TypeScript check and production bundle |
| R2 runner | PASS | `node tests/run-regressions.mjs --only snapshot-r2-runner`: 37 assertions |
| Full-restore orchestration | PASS | Changes, undeletes, Markdown/blob removal, backups, offline/server/unconfirmed-snapshot failure, disk/binary races, new path during review, backup failure, trash failure, post-commit disk/revival races, suppression and unbinding |
| Confirmation/view tests | PASS | Actual modal handlers: two/three-way UI, resolution mapping, reviewed-side staleness, 200/201 and 50/51 thresholds, duplicate submission, created-blob-only entry, snapshot cleanup ownership |
| Chromium fixture | PASS | `node tests/recovery-ui-browser.mjs`: desktop 1280×960 and mobile 390×844, side preview, per-hunk combination, merged apply, manual fallback, typed full restore; no page errors/horizontal overflow |
| 2,000-file synthetic capture | PASS | 2,000 changed notes plus change/delete/create fixture; 229 ms final sample; this is not an Obsidian vault timing |
| Source additivity check | PASS | Existing controller keep-local/use-remote branches compared byte-for-byte with HEAD |
| New/edited recovery module lint | PASS | Explicit ESLint run on recovery helpers/modal/service, dashboard, snapshot client, DiskMirror, telemetry types |
| Whole modified-file lint | FAIL (existing debt) | Seven existing errors in `main.ts` and `reconciliationController.ts`; unrelated UI sentence-case/console findings were retained |
| Patch whitespace | PASS | `git diff --check` |
| Actual Obsidian multi-device acceptance | NOT_RUN | Browser fixture uses an Obsidian API shim; no live desktop/mobile vault or real remote-device campaign |
| Git publication / deployment | NOT_RUN | Changes remain in the working tree |

Full regression environment preparation: the inherited `KAOS_PLUGIN_DIR` pointed
at an unrelated local vault, so it was unset for the regression process. The
existing Oracle rehearsal boundary test hardcodes `/private/tmp`; its local test
directory was prepared on Linux. One earlier CLI fatal-cleanup run timed out;
its unchanged suite passed in isolation and the subsequent complete 185-suite
run passed. Tests were not relaxed or skipped.

Browser screenshots are at `/tmp/kaos-recovery-ui/{desktop,mobile}-{conflict,full-restore}.png`.
The manual browser script requires Playwright Chromium (`npx playwright install chromium`).
The registered `snapshots.ts` suite runs its pure category through the regression
runner; its pre-existing opt-in live endpoint behavior remains available outside
that runner. R2 behavior is verified separately by the local R2 runner.

## Operational limits retained

Full restore applies a soft Yjs operation to synchronized content. Attachment
settlement continues through existing blob sync; missing objects, authority
pauses, and local-dirty preservation remain possible. `.completed` means the
restore transaction and explicit Markdown disk settlement completed, not that
every remote device or attachment download has finished. Remote concurrent work
may merge or revive deleted paths under the existing preservation policy.

The real Obsidian multi-device campaign remains necessary for release acceptance.
