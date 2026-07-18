## Summary

<!-- What changed and why? -->

## Verification

<!-- List the focused checks you ran. -->

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
