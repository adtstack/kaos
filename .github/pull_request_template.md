## Summary

<!-- What changed and why? -->

## Verification

<!-- List the focused checks you ran. -->

## Sync and physical-device safety

For changes that touch live sync, socket admission or reconnect, persistence,
conflict handling, attachment transfer, or the mobile lifecycle:

- [ ] I linked evidence from a fresh active edit converging across the affected
      real-device topology (three devices when multi-device behavior changed).
- [ ] I linked evidence that background/foreground or network restoration
      reconnects without a plugin reload when reconnect or lifecycle code changed.
- [ ] I linked real-device evidence that competing versions survive conflict
      handling changes (CRDT merge / server journal+snapshots / disk-index
      baseline / git recovery layer; discarded revisions reach the server
      audit log; no editor rollback occurs).
- [ ] I linked bounded soak or stress evidence when retry, timer, queue, or
      backoff behavior changed.
- [ ] The Verification section records device/OS, Obsidian, plugin, and server
      versions and points to the retained evidence.

Mark each inapplicable item `N/A` with a short reason. Automated and desktop-CDP
tests support these checks but do not replace applicable real-device evidence.

## Remote cost safety

For changes that can reach a Worker, Durable Object, DO storage, R2, reconnect
path, dashboard refresh, or background timer:

- [ ] I documented the request graph and 1/3/10-device daily operation counts.
- [ ] Idle diagnostics and no-change paths perform no remote writes or polling.
- [ ] Cheap room probes use at most one DO fetch and do not hydrate the Y.Doc.
- [ ] Retries/timers have cancellation, backoff, jitter, and a bounded rate, or
      the change explains why they are not remote retries.
- [ ] I tested the relevant rolling-deployment combinations.
- [ ] `npm run guard:do-cost` passes.

If none of these systems are touched, mark this section `N/A` with a short
reason. See
[`docs/engineering/durable-object-cost-guardrails.md`](../docs/engineering/durable-object-cost-guardrails.md).
