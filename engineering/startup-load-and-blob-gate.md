# Startup determinism and attachment materialization

This note explains the architectural tradeoff we made after fixing the
"plugin taking too long to load" class of failures.

The short version:

- startup must be deterministic and local-first
- network metadata cannot be on the plugin-load critical path
- attachment materialization must wait until local host state is trustworthy

## The failure pattern we hit

This issue did not come from carelessness. It came from a product instinct we
care about: get sync online before users start typing into stale state.

We were explicitly trying to avoid the classic UX failure mode:

- user opens vault
- starts writing before remote state lands
- then sees late merges/conflicts and loses confidence in sync

So we biased startup toward "sync certainty before user action." In practice,
we treated server capability probing as a startup prerequisite.
That improved certainty, but it made load determinism depend on the network.

That decision coupled plugin-load completion to the first cold DNS/HTTP
round-trip. On bad resolver paths, boot became network-bound before the user
could even start.

Once we instrumented startup by phase, the timeline became unambiguous:

- plugin load was waiting on capability fetch
- the dominant stall was in client networking cold path
- sync runtime startup itself was not the primary blocker

After removing that startup block, KAOS became fast enough to expose a second
issue: attachment download decisions were sometimes made before Obsidian's local
vault model had fully settled. In that window, a file could exist on disk while
the in-memory view still looked "missing," which led to wasted work and `EEXIST`
races.

So we had two different problems with one common theme:

- we were trusting non-authoritative state too early during boot

## The design we settled on

### 1) Separate startup-critical work from optional metadata

Core sync startup is now independent from capabilities probing.

- Core path: local settings, local runtime bring-up, provider connect/sync.
- Optional path: capability refresh, trace refresh, and feature toggles.

Capabilities are still important, but they are metadata, not a boot gate.
This preserves fast readiness under slow/hostile network conditions.

This first fix changed startup character immediately. `onload()` moved from
"blocked behind network metadata" to effectively instant completion, with
measured runs around ~10ms. In practical terms, KAOS startup became faster than
the host's visible startup noise, which is exactly where plugin load should
live. It felt less like "booting a plugin" and more like "already there."

### 2) Use last-known capabilities, but stay conservative

We cache last-known capabilities per host to avoid "unknown everything" on every
cold boot, but we do not treat cached values as hard truth for core startup.

Tradeoff:

- Better UX continuity for optional features.
- Possible short window of stale capability assumptions until background refresh
  completes.

We intentionally prefer conservative behavior for optional features over
optimistic behavior that can misfire.

### 3) Split attachment startup into "observe now, materialize later"

Attachment observers can start early, but download execution is gated.

During early boot, KAOS records intent (queue state) without immediately
materializing every remote blob reference. Draining the download queue opens only
after two readiness conditions:

- host lifecycle ready (`layoutReady`)
- KAOS lifecycle ready (startup/reconcile boundary reached)

This keeps the main benefit of fast boot (startup is not blocked) without lying
to ourselves about local file presence too early.

### 4) Keep `EEXIST` handling as defensive safety, not primary control flow

The gate removes the dominant startup race, but filesystem TOCTOU races can still
happen later (user actions, other processes, cloud sync tools, etc.).

So `EEXIST` handling stays as a narrow recovery path:

- not the architecture
- not the normal path
- just fault tolerance for real concurrent filesystem behavior

## Why this architecture fits KAOS

KAOS is explicitly local-first. That means startup should degrade gracefully when
network state is bad, and should not regress into "UI held hostage by metadata."

This design keeps the promise:

- fast plugin load
- fast text sync bring-up
- attachment correctness with fewer spurious downloads
- bounded behavior under startup races

It also scales better to mobile conditions, where DNS/radio wakeups and host
lifecycle timing are often noisier than desktop.

## Tradeoffs we accept

- First cold boot on a host can stage optional capability-driven behavior behind
  a background refresh.
- Attachment downloads may begin slightly later than the earliest theoretically
  possible moment, because we prioritize authoritative local-state checks over
  eager I/O.
- We keep extra startup traces to preserve observability at phase boundaries.

These are intentional product tradeoffs in favor of deterministic boot and
correctness.

## Commits carrying this design

- `39dcdbd` `fix(startup): make capability checks non-blocking and cache server capabilities`
- `ded8725` `fix(attachments): gate startup downloads until vault is ready`
- follow-up on `main` keeps blob startup non-blocking and gate-aware

The result is not "network became fast." The result is that network slowness no
longer owns plugin startup correctness.
