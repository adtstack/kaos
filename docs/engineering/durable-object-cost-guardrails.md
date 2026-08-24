# Durable Object Cost Guardrails

This document is the review contract for code that can reach a Cloudflare
Worker, Durable Object (DO), DO storage, or R2. It exists because an idle
diagnostics loop once multiplied one read into two DO requests every 15 seconds
on every connected device.

The rules are expressed as operation counts rather than currency. Cloudflare
pricing can change; request fan-out, storage operations, and document hydration
remain properties of this codebase.

## Non-negotiable defaults

1. **Idle observability costs zero remote operations.** Logs, debug panels,
   traces, status snapshots, and health displays must not poll a Worker or DO
   while the user is idle. Refresh them on explicit demand or from state already
   delivered by the sync connection.
2. **High-frequency no-change paths do not write.** A status timer, reconnect,
   health check, or rejected request must not persist a trace merely to say that
   it ran. Scheduled maintenance status traces require an explicit cadence and
   must not add another document hydration.
3. **A cheap room probe is one DO request.** Metadata, schema, and debug reads
   may perform at most one `stub.fetch()` per Worker request. They must not load
   the Y.Doc, replay a checkpoint/journal, or use `getServerByName()`.
4. **Route classification precedes paid work.** Authentication storage, room
   lookup, document hydration, and trace persistence happen only after the
   Worker has accepted the route shape.
5. **Per-device timers are multiplicative.** Server maintenance should be
   coordinated per vault on the server whenever possible. Client idempotency
   does not make duplicate requests free.
6. **Retries back off and stop.** Remote retries require exponential backoff,
   jitter, a cap, and a terminal/paused state. A fixed short interval is not a
   retry policy.
7. **Both halves of a rolling deployment are costed.** Review the old-client /
   new-server and new-client / old-server combinations. A server-side throttle
   does not remove requests from an old polling client.

Any exception must be written down next to the timer or call site with its
owner, trigger, maximum frequency, and worst-case request graph. "Debug only"
is not an exception: debug mode can remain enabled on several devices for
months.

## Endpoint budgets

| Endpoint class | Automatic idle rate | DO fan-out per Worker request | Y.Doc hydration | Storage contract |
| --- | ---: | ---: | --- | --- |
| Diagnostics / debug / health | 0 | at most 1, on demand | forbidden | bounded reads only |
| Metadata / schema probe | startup or connection event only | at most 1 | forbidden | one bounded record/read |
| WebSocket sync admission | connection event only | documented | required for accepted sync | document lifecycle only |
| Document export or mutation | explicit product operation | documented | allowed | bounded or paginated |
| Snapshot / recovery maintenance | documented cadence, idempotent per vault | documented | allowed when required | bounded batches with continuation |

`storage.list()` must always have a limit or prefix that bounds the result.
Returning fewer records to the caller does not help if the server first reads an
unbounded collection.

## Approved recurring remote paths

This table inventories current exceptions to a zero-background-network default.
It is not permission to add another timer. Shortening a cadence or widening its
trigger requires a new cost calculation and request-count test.

| Path | Current cadence / scope | Why it exists | Bound |
| --- | --- | --- | --- |
| Socket ticket refresh / reconnect | about every 55 minutes per connected device; connection events only otherwise | keeps reconnect credentials valid without allowing a socket or ticket retry storm | ticket HTTP and connect attempts are single-flight; `connection-close` pauses the vendor reconnect loop, including handshake failures that emit no disconnected status; one immediate recovery is allowed after proven sync, then pre-sync closes use equal-jitter exponential windows from 30–60 seconds up to a 2.5–5 minute cap; socket open does not reset this backoff—only Yjs `sync(true)` does; offline, fatal auth, explicit disconnect, and destroy stop requests until an explicit safe resume |
| Recovery history maintenance | hourly per connected device when snapshots are supported | advances bounded file-history uploads | server idempotency, batch continuation, in-flight guard |
| CRDT daily snapshot | daily per connected device when snapshots are supported | off-document recovery point | server daily idempotency |
| Guided server update monitor | every 30 seconds only while an update is active | detects completion of an explicit deployment | persisted update state; 30-minute terminal timeout |
| Open dashboard data | UI refresh every 30 seconds while the view is open | keeps an explicitly visible dashboard current | remote snapshot data cached for 5 minutes; timer disposed with view |

Missing optional R2 capabilities are not an active operation. They must not keep
the guided-update monitor alive. Capability refreshes outside an explicit update
are event-driven (startup, foreground, network restoration, provider sync, or
manual refresh).

## Required cost calculation

Every new recurring remote path must include this calculation in its PR or
design note:

```text
fires_per_day = 86,400,000 / interval_ms
worker_requests_per_day = devices_per_vault * fires_per_day
do_requests_per_day = worker_requests_per_day * do_fetches_per_fire
storage_ops_per_day = do_requests_per_day * storage_ops_per_fetch
```

Show at least 1, 3, and 10 continuously running devices. Also state the cold-DO
path separately because a request that looks like a small read may run
`onStart()` -> `onLoad()` and replay the full document.

The incident that motivated this guard had this shape:

```text
3 devices * 5,760 polls/day * 2 DO fetches/poll = 34,560 DO fetches/day
```

There were no user edits. The multiplier came entirely from an idle 15-second
debug poll plus PartyServer's hidden `/set-name/` request.

## PartyServer rules

`getServerByName(namespace, room)` is not a local lookup. In the pinned
PartyServer version it sends a `/cdn-cgi/partyserver/set-name/` request before
returning the stub. PartyServer initializes the server before answering that
route, and `y-partyserver` initialization calls `onLoad()`.

Therefore:

- Use `getServerByName()` only when the operation intentionally enters the
  document-owning lifecycle, such as an accepted sync socket or document-based
  snapshot operation.
- For cheap endpoints, resolve `idFromName()`, call `namespace.get()`, and put
  `x-partykit-room` on the same single request.
- Do not assume an early route check in the application subclass protects a
  later `super.fetch()` call. Verify the framework lifecycle with a runtime
  request-count test.
- A new `getServerByName()` call site must update the explicit allowlist in
  `tests/server-do-amplification.mjs` and explain why one direct request is not
  sufficient.

## Timer and retry review checklist

Any change adding or modifying `setInterval`, a self-rescheduling `setTimeout`,
dashboard auto-refresh, reconnect logic, or background maintenance must answer:

- Does the callback reach `fetch`, a WebSocket reconnect, a DO stub, DO storage,
  or R2, including through an indirect method?
- What stops the timer when the view, plugin, or connection is disposed?
- What happens with three devices open and no edits for 24 hours?
- Can one device or the server own the work for the entire vault?
- Is the no-change response free of writes and document hydration?
- Are retry backoff, jitter, caps, and cancellation tested?
- Is there a kill switch or safe server-side throttle for already deployed
  clients?

If the first answer is yes, add a request-count test. Static source checks alone
are insufficient for framework lifecycle behavior.

## Verification contract

Run the focused cost guard for every Worker/DO, diagnostics, timer, dashboard,
snapshot-maintenance, or reconnect change:

```bash
npm run guard:do-cost
```

The full regression suite also runs the same checks:

```bash
npm run test:regressions
```

The guard currently enforces:

- no persisted DO trace write on WebSocket admission;
- route classification before auth storage access;
- cached auth configuration reads;
- exactly one DO fetch for cheap debug/meta probes;
- no document load in the debug handler;
- no periodic server-trace polling in the plugin;
- an explicit allowlist for every `getServerByName()` call under `server/src`; and
- no indefinite capabilities polling merely because optional R2 is absent.

When a legitimate architecture change requires updating a guard, update this
document, the request-count test, and the allowlist in the same change. Do not
weaken the guard merely to make a new call site pass.

## Deployment checklist

Before release:

1. Test idle behavior with 1 and 3 clients for longer than the shortest timer.
2. Count Worker requests, DO stub fetches, storage reads/writes, and cold loads.
3. Test old plugin/new Worker and new plugin/old Worker combinations.
4. Deploy the server-side limiter or cheap path before distributing clients
   when that ordering reduces risk.
5. Confirm all always-on devices receive the plugin update; one old polling
   client can keep the incident alive.
