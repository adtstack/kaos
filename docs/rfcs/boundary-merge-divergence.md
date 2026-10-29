# RFC: Boundary-Native Divergence Handling — merge instead of detach at editor ↔ Y.Text ↔ disk

**Status:** Draft (problem accepted, fix pending)
**Target repository:** KAOS / Obsidian CRDT sync
**Date:** 2026-10-01
**Owner:** TBD
**Reviewers:** TBD

## Fix Progress

| Stage | Description | Status | Design | Commit |
|-------|-------------|--------|--------|--------|
| Stage 0 | Contamination gate: block destructive disk-wins on remote-advanced local-only divergence | Shipped (1.13.4) | — | `21d8a60` |
| Stage 0.5 | Manual resolution path: "Resolve paused sync recovery" command + keep-local/keep-remote | Shipped (main) | — | `eedf7fb` |
| Stage 1 | Divergence-origin telemetry: tag the first-detected divergence per pane | Pending | §7 | — |
| Stage 2 | Boundary B (Y.Text↔disk): port 3-way auto-merge into the held open-file path | Pending | §8 | — |
| Stage 3 | Boundary A (editor↔Y.Text): settle-then-rebind with certified anchor replay | Pending | §9–§10 | — |

---

## 1. Summary

Every recent data-loss/split-brain incident in this codebase — first-open revert (2026-09-16), self-mirror loopback (2026-09-30), typing loss (2026-10-01 AM), frozen-pane split-brain (2026-10-01 PM) — is the same defect class:

> The editor ↔ Y.Text ↔ disk pipeline is asynchronous by design, and transient in-flight states (sub-second to sub-minute mismatches) are being interpreted by authority checks as durable, irreversible states.

The checks then make permanent decisions (replace, detach, hold) on what was actually a moving snapshot. This RFC specifies the end-state: **every boundary, on detecting mismatch, merges against a base anchor and re-attaches, instead of detaching or replacing.** With that in place, user-facing version choices become a rare last resort rather than the primary convergence path.

## 2. Incident record (evidence base)

2026-10-01, vault `thirdb.pro`, room `ktiKqpBLlLOVtPkLBDblxA` (kaos-sync.kknd2065.workers.dev), devices `workspace` and `home`, both 1.13.3.

**AM (typing loss, boot `boot-puxe69n6GGkRng`):** four shrink events — daily `2026-10-01.md` 420→414 and 497→472 chars, weekly `2026-09-W39.md` 18875→18835 and 18880→18856. Each coincides with `server.receipt.confirmed` showing the server state vector ahead of our candidate, and (for W39) explicit `provider-remote` arrivals. No kaos disk write touched the daily note (Obsidian autosave of an already-shrunk editor); the 09:13:50 flush the user suspected was downstream only. Cross-device proof: home `boot-qKC2jDjWMWWuVw` at 00:33:23.788 logged `bound-file-recovery-source-selected {chosenSource: "disk", editorLengths: [18993]}`; workspace received it 00:33:21.906 and flushed exactly 18993 chars at 00:33:23.434.

**PM (split-brain, after the 1.13.4 gate):** W39 stable at editor=disk=18885 (local truth) vs CRDT=18887 (room), first diff index 207, `binding: null`, sync facet absent, `binding-target-editor-diverged` ×247. The gate prevented destruction (local text survived — its purpose) but no convergence path existed, so the divergence persisted indefinitely.

## 3. Root cause, layered

**L1 — the misjudged verdicts themselves.** `localOnlyViews = editorMatchesDisk && !editorMatchesCrdt` (`reconciliationController.ts`, local-only branch) cannot distinguish "CRDT trails local typing" (safe disk-wins) from "CRDT advanced via remote" (destructive disk-wins). Fixed by the contamination gate (Stage 0).

**L2 — the binding divergence skip is a one-way trap.** `editorBinding.ts:4370`: when editor ≠ CRDT, `resolveBindingTarget` skips binding (except `heal`-prefixed reasons). Once any transient divergence is observed at the wrong instant, the editor is frozen out of sync permanently; every later attempt re-observes the (now larger) gap. The freeze is what manufactures the split-brain. The `heal()` bypass is dead code and itself has the inverted bug (pushes a stale editor into CRDT unconditionally) — do not re-wire it as-is.

**L3 — why the trap fires so often.** The binding path has zero tolerance window: checks run against an asynchronously-consistent pipeline (ysync lag, IME composition, reconnect resync, ~2s Obsidian autosave, ~5min socket ticket refresh), so the probability of sampling a transient mismatch is high on exactly the files users keep open longest. Workflow amplifier: the same notes (weekly, daily) are kept open on both machines all day, which is also the precondition for the duplicate-fileId double-seed (`create` ×2 per note, 2026-09-30).

## 4. End-state architecture: merge at every boundary

```
editor ──(Boundary A)── Y.Text ──(Boundary B)── disk
```

On detected mismatch at a boundary, do not detach/replace/hold. Compute a merge against that boundary's base anchor, apply atomically, re-attach. The correct merge tool differs per boundary:

### Boundary A (editor ↔ Y.Text): CRDT delta replay, not string 3-way

The CRDT is the merge algorithm — but only while changes are **ops**. Detachment turns editor changes into a frozen **blob** that can only be string-diffed. Boundary-A merge means converting the blob back into ops:

1. Base anchor = last certified agreement between the pane and Y.Text (the `LocalOnlyRecoveryEvidence` checkpoint: "editor = last projection + local edits").
2. `merged = mergeTexts3(anchor, editor, crdt)` — the anchor-based 3-way whose result already contains every remote change — applied to Y.Text via `applyDiffToYTextWithPostcondition(ytext, crdt, merged, …)`, i.e. a diff against the **current** CRDT content under CAS. **Never apply `diff(anchor → editor)` offsets directly to Y.Text**: those offsets are anchor-relative and the CRDT has moved; raw replay is the text-mangling failure mode. The only legal replay is anchor-3-way → diff(current → merged).
3. The CRDT integrates the applied diff with remote ops — character granularity, both sides preserved, same-line edits coexist rather than conflict.
4. Project the merged result into the pane (`refreshStaleEditorPanes`) and bind.

### Boundary B (Y.Text ↔ disk): string 3-way

Disk only has strings, so 3-way is correct here, and the base anchor already exists and is durable: the disk-index baseline (`contentHash` → baseline text store). This is 80% implemented — `closed-file-3way-auto-merge` already runs `mergeTexts3(base, disk, crdt)` on both-changed closed files and auto-applies clean merges. Stage 2 ports the same pattern into the held open-file path.

### The hard 20%: safety at "that moment"

The merge primitives (`mergeTexts3`, `applyDiffToYTextWithPostcondition`, mutation-ticket CAS) already exist. What makes "merge at the moment of detection" unsafe is that the moment of detection is the moment of maximal turbulence. Three guards, all with existing primitives:

1. **Quiescence:** settle window (1–2s, composition inactive, in-flight drains empty) before deciding. Reuse the existing settle/idle windows; do not decide mid-flight.
2. **Atomic application:** mutation tickets + CAS postconditions already fence "changed between compute and apply."
3. **Double-apply protection (Boundary A's specific risk):** if the anchor is older than the true last agreement, delta replay duplicates text. The certification ladder decides:
   - certified local lag → CRDT delta replay (above);
   - uncertified → degrade to string 3-way against the durable baseline;
   - base unknown → freeze + hold (current behavior, now rare).

### Degradation ladder (unified)

```
settle → certified? ── yes → CRDT delta replay (Boundary A) / 3-way clean (Boundary B)
                  └── no  → string 3-way (baseline-anchored)
                              ├─ clean  → apply atomically, re-attach
                              └─ conflict hunks → hold + manual UI (Stage 0.5, last resort)
```

With Boundary A at character granularity, "conflict" in the user-facing sense nearly disappears: overlapping edits coexist side by side and are cleaned up by ordinary editing. The manual modal remains for genuinely undecidable cases (e.g., Boundary B with missing baseline).

## 5. Non-goals

- Re-wiring `heal()` (inverted-shape bug; superseded by the certified rebind).
- Auto-choosing a winner for same-line human conflicts (CRDT coexistence + manual cleanup instead; explicit choice only via the Stage 0.5 modal).
- Duplicate-fileId double-seed fix — separate defect (create-path idempotency), same workflow precondition; tracked separately.

## 6. Verification plan

- Stage 1: divergence-origin tags must appear in traces before/while Stage 3 lands (measure first).
- Stages 2–3: two-client QA room repro (A types + pauses, B has same file open with induced binding divergence) asserting (a) no delete ops authored against A's ranges, (b) convergence without user action, (c) certification-ladder coverage (certified / uncertified-clean / conflict).
- Existing gates: `npm run test:regressions`, `npm run build`; note worktrees need `server/ npm ci` for `snapshot-r2-runner`.

---

# Implementation design (Stages 1–3)

## 7. Stage 1 — divergence-origin telemetry

**Touchpoint:** `src/sync/editorBinding.ts`, `resolveBindingTarget` at the `contentDiverged` branch (≈ line 4370).

**Behavior:** on the *first* divergence observation for a (leafId, path) episode — not on every skip — classify the origin from signals that already exist at that site:

| Tag | Signal | Source |
|-----|--------|--------|
| `composition-active` | `isCompositionActive(liveCm)` | editorBinding (compositionAwareYSync) |
| `pending-remote-projection` | `remoteTextRevisionTracker` revision for this Y.Text advanced within 1500 ms | `vaultSync.remoteTextRevisions` |
| `recent-reconnect` | provider reconnected within 5000 ms | connectionController state |
| `recent-disk-modify` | markdown disk revision bumped within 2500 ms | controller `noteMarkdownDiskMutation` |
| `unknown` | none of the above | — |

Emit trace `binding-divergence-first-observed` `{path, leafId, origin, editorLength, crdtLength, remoteRevision, authorityRevision}` plus a flight event (new `PRODUCT_EVENT_KIND.bindingDivergenceObserved`; requires `FLIGHT_TAXONOMY_VERSION` bump per convention). Episode key resets when a bind succeeds or the view closes.

**Acceptance:** after 1–2 days of the dual-desktop workflow the origin distribution is non-empty and dominated by ≤2 classes. That distribution sets the Stage 3 settle window (settle ≥ p99 observed transient duration) and tells us whether one signal class needs its own fix.

**Cost:** inert by construction (observation only); ships ahead of the behavioral stages.

## 8. Stage 2 — Boundary B: 3-way merge in the held open-file path

**Touchpoint:** `src/runtime/reconciliationController.ts`, local-only branch, at the point where the contamination detail is computed non-null — *before* `holdAutomaticRecovery` is called. New private `attemptBoundaryDiskThreeWay(...)`.

**Decision ladder (in order):**

1. Existing idle window not yet satisfied → existing deferral (unchanged).
2. `baselineText = await getBaselineText(diskIndex[path].contentHash)` is null → hold (existing path).
3. `mergeTexts3(baselineText, localContent, crdtContent)`:
   - `clean-merge` → apply (below);
   - `conflict` → hold (existing path; manual modal remains the fallback);
   - `no-base` → hold.
4. Apply atomically: `commitMutation("boundary-b-3way-merge", crdtContent, () => applyDiffToYTextWithPostcondition(ytext, crdtContent, merged, ORIGIN_BOUNDARY_MERGE))`; on success → `refreshStaleEditorPanes(openViews, merged, path)` → `admitOpenFlush` settlement → clear evidence/holds → flight `recovery.decision {reason: "boundary-3way-auto-merge", action: "apply-merged"}`.
5. Any stale/postcondition failure → fall through to hold unchanged (retry on the next drain).

**New constant:** `ORIGIN_BOUNDARY_MERGE = "boundary-merge"` in `src/sync/origins.ts`, registered in `LOCAL_STRING_ORIGIN_SET` in the same change (module convention). Auditability requires its own origin — do not reuse `ORIGIN_OPEN_EXTERNAL_EDIT_MERGE`.

**Guards already in place and reused:** mutation-ticket CAS, `shouldQuarantineAmplification`/`shouldQuarantineRepeatedRecovery` (feed them the merged lengths), single-pane authority requirement, and the Stage 0 gate stays as the hard floor — if any predicate here is wrong, the destructive path remains blocked.

**Flag:** `runtimeConfig.boundaryMerge.disk3Way`, default **on** (the merge is strictly less destructive than what the hold replaced and preserves both texts).

## 9. Stage 3 — Boundary A: settle-retry + certified anchor replay rebind

### 9.1 Settle-then-retry (kills the one-way trap for transients)

At the `contentDiverged` skip site: instead of returning `null` permanently, schedule **one** deferred re-evaluation (`reason: "settle-retry"`) after `SETTLE_MS` (start: 1200 ms; tune from Stage 1 p99) if none is scheduled for the leaf and the view is still alive. The retry runs the *normal* `resolveBindingTarget` — if the transient has drained, contents match and the bind attaches; nothing else changed. Only a still-diverged editor proceeds to 9.2.

### 9.2 Certified anchor replay

**Evidence extension (one field):** `LocalOnlyPaneEvidence` gains `anchorContent` — the editor text captured at the agreement checkpoint (`localSuccessor === false`, where editor === CRDT). Retained alongside `content` through the successor chain; cleared by `invalidate()`. This is the base anchor Boundary A needs and is currently not retained.

**Lane selection on the post-settle retry:**

- Pane evidence certified (the `localOnlyRecoveryBlockReason` chain verifies, including `pane.remoteRevision === tracker.remoteRevision`) → base = `anchorContent`.
- Anything else → degrade: base = disk-index baseline text (Boundary B's anchor); if that is null too → freeze (current behavior; controller gate + Stage 0.5 modal take over).

**Merge + apply (both lanes share it):**

```
merged = mergeTexts3(base, editorContent, crdtContent)   // left=local, right=remote
clean  → CAS check (editorRevision + ytext.toJSON unchanged since capture)
        → applyDiffToYTextWithPostcondition(ytext, crdt, merged, ORIGIN_BOUNDARY_REPLAY)
        → set editor content to merged (pane-level refresh)
        → attach binding (contents equal now; ordinary bind path)
conflict → freeze + hold (manual modal)
CAS fail → reschedule the retry once; second failure → freeze
```

Note the replay is *realized* as an anchor-based 3-way whose result is applied into the CRDT as ops: `merged` contains the remote content, so the diff `(crdt → merged)` never deletes remote ranges — the double-apply and clobber risks are both fenced by the anchor certification and the CAS.

**Settle is a re-armable gate, not a fixed timer.** At fire time, re-check: editor activity within the window, composition active, or in-flight ysync ⇒ re-arm the timer instead of proceeding. A user who resumes typing at t+1.2s must never observe a background merge dispatching into their live editor; the merge only runs when the pane has genuinely gone quiet. The editor-side application maps selections through the change (the CM6 selection-mapping machinery ysync already uses), so a paused user's cursor is not displaced.

**New constant:** `ORIGIN_BOUNDARY_REPLAY = "boundary-replay"` + `LOCAL_STRING_ORIGIN_SET` registration.

**Never during composition; settle window enforced; at most one in-flight replay per leaf.**

**Flag:** `runtimeConfig.boundaryMerge.editorRebind`, default **off**; flip after Stage 1 data and a soak period. (`getRuntimeConfig().automaticRecoveryMode` is the precedent for this knob shape.)

## 10. Rollout

| Stage | Default | Rationale |
|-------|---------|-----------|
| 1 telemetry | on, inert | observation only |
| 2 disk-boundary 3-way | on | strictly safer than the hold it precedes; conflict fallback keeps the old behavior |
| 3 editor rebind | off → on after soak | touches live typing paths; needs Stage 1 p99 data |

Sequencing rule: Stage 3 must not ship before Stage 1 has produced at least one full dual-desktop workday of origin data.

## 11. Test matrix

**Stage 2** (extend `tests/recovery-hold-resolution.ts` fixture):

1. Held shape + clean 3-way → converges (CRDT = merged, panes refreshed, hold never registered, flight `boundary-3way-auto-merge`).
2. Overlapping hunks → hold registered, manual modal path intact.
3. Missing baseline → hold.
4. CAS stale between merge and apply → hold retained, retried next drain.
5. Amplification quarantine still trips on repeated merged applies.

**Stage 3** (binding-level, follow `tests/editor-binding-health-regressions.mjs` harness):

1. Transient divergence (diverged at t0, converged by t0+settle) → retry binds; no freeze, no merge applied.
2. Certified anchor replay → both sides' edits present in CRDT and editor; bind attached; origin string on the transaction is `boundary-replay`.
3. Anchor conflict (same line both sides) → freeze; controller hold + manual modal.
4. CRDT advances between capture and apply → CAS abort, single reschedule, second abort → freeze.
5. Composition active at retry time → retry deferred, never merges mid-composition.

**Two-client QA room (both stages):** device A types and pauses; device B holds the same file with an induced frozen binding; assert (a) zero delete ops authored against A's ranges, (b) convergence without user action for disjoint edits, (c) manual modal reached only for same-line conflicts.

## 12. Review hardening (2026-10-01 design review)

An external review of this RFC correctly stressed that every automation layer added here can become a new corruption vector. Findings, verdicts against the code, and adopted mitigations:

**R1 — Offset transposition ("anchor-relative offsets applied to a moved Y.Text delete remote ranges").**
Valid against §4's original phrasing ("apply diff(anchor→editor) as ops") — an implementer following that sentence alone would build the mangling version. Verdict against the actual design: the §9.2 apply path is `applyDiffToYTextWithPostcondition(ytext, currentCrdt, merged)`, and the primitive's stale-base branch (`src/sync/diff.ts:216`) explicitly refuses to replay stale patches — it concurrent-merges instead, with the "text merges together and disappears" failure mode named in its own comment. §4 has been rewritten normatively. **Adopted as a hard invariant (I1):** no boundary-merge code path may emit a delete whose range intersects a remotely-modified hunk; enforced by construction (diff target is `current → merged`, merged ⊇ remote hunks) and by an explicit test asserting the delete-set of every applied patch avoids remote ranges.

**R2 — Anchor misjudgment duplicates text.**
Real risk class with precedent. Existing defenses: the certification chain invalidates (not trusts) unprovable anchors, and `mergeTexts3` routes shared-reintroduction and repeated-line alignments to `conflict` rather than double-applying. Residual: a chain that certifies while wrong. **Adopted:** pre-merge invisible snapshots of both sides (R6), an explicit stale-anchor regression test simulating a partial-sync-broken chain, and a duplication postcondition check (the applied result must not contain the anchor's changed region twice).

**R3 — Settle window races live typing.**
Valid. **Adopted:** settle is re-armable — at fire time, any editor activity, active composition, or in-flight ysync re-arms instead of proceeding; the editor-side application maps selections through the change. Spec updated in §9.2.

**R4 — DiskMirror echo/ping-pong loop.**
Managed by existing machinery: local-repair origins (including the new ones) are excluded from DiskMirror's remote-write scheduling, Obsidian's autosave of the refreshed editor is attributed via the suppression windows that already govern every other recovery origin, the post-merge baseline settle makes disk==editor==CRDT (no further mismatch events), and the amplification/fingerprint quarantines bound repetition. **Adopted:** an explicit convergence-stop test — after one merge cycle, no further boundary-merge events fire for the path absent new edits.

**R5 — "Dual source of truth makes perfect reconciliation impossible."**
Correct diagnosis, overstated conclusion. The boundary-merge direction is precisely the reduction of the problem: while an editor is live and bound, the CRDT is the single authority and the editor is its projection; disk is a materialized view reconciled at settle points. The incidents in §2 all stem from divergence windows *promoting* disk/editor to authorities (the local-only disk-wins, the frozen editor blob). Restated as the governing principle (P1): **no component may act as a content authority while a fresher agreement is provable; detection of in-flight states must defer, not decide.** The existing editor-bound paths (disk reconciliation blocked while typing, editor↔Y.Text as the only live pair) already implement most of this; the remaining exceptions are exactly the L2/L3 surfaces this RFC closes.

**R6 — Pre-merge invisible snapshots (review recommendation).**
**Adopted.** Before any Stage 2/3 apply, both sides' text (editor + CRDT strings, with lengths/hashes) is recorded into the flight event and the existing discarded-revision audit — an invisible trace record, not a vault artifact (the 1.12.0 artifact abolition stands). Any mangling becomes recoverable and diagnosable after the fact.

**R7 — Simplify instead of automate (review recommendation "single-truth while typing").**
Partially adopted as audit work, not new machinery: inventory the remaining paths where disk reconciliation can act on a file with a live editor and close them under P1. This is a narrowing task on existing code, listed as a Stage 3 acceptance criterion.
