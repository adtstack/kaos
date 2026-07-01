# Live Editor Authority Policy

Status: active policy as of 2026-07-01.

This document records the policy for protecting an open CodeMirror/Yjs editor
from stale whole-document style patches while preserving normal live
collaboration.

## Decision

Use recent local typing as the protection boundary.

Do not use "the file is open" as the boundary.
Do not auto-merge live editor strings outside Yjs.
Do not remove editor binding or cursor state unless the recent-typing shield
still fails in production.

Current policy:

1. Let normal Yjs collaboration patches flow.
2. Let any incoming patch flow when it preserves the current editor content.
3. If an incoming non-user patch would remove current editor content, treat it
   as destructive.
4. Shield a destructive patch only when this device has a real document edit
   for the same binding within `RECENT_EDITOR_PATCH_SHIELD_MS` (currently
   5000 ms).
5. If the editor is merely open but has no recent local typing, do not shield
   the patch.
6. If conflict preservation is needed, use existing conflict artifact /
   reconciliation paths outside the live editor. The live editor does not do
   automatic 3-way merges.

## Why "open" Is Not Enough

An open editor can be passive. Two devices may have the same note open while
only one device is actively editing. If the passive device blocks destructive
patches just because the file is open, it can keep reasserting old local editor
state and make the active device's edits appear to bounce back.

This was the failure shape where two devices on the same page could not type
even one character.

The correct signal is not visibility. The correct signal is recent user
document activity on that device.

## Why Not Live 3-Way Auto-Merge

Closed-file reconciliation can use 3-way text merge because it owns a clear
authority decision: disk, CRDT, and baseline are explicit inputs.

The live editor already has two sophisticated state machines:

- Yjs CRDT merge semantics
- CodeMirror document, selection, and undo semantics

Adding a separate string-level auto-merge inside the live editor creates a
third authority. Even when a line-level merge is clean on paper, it can be
wrong for cursor placement, undo history, same-line intent, delete intent, and
provider-origin classification.

Therefore live editor auto-merge is a non-goal. If two live states cannot be
accepted by normal Yjs propagation, KAOS should preserve or defer rather than
invent a merged document in the editor binding layer.

## Policy Matrix

| Situation | Action | Rationale |
|---|---|---|
| User transaction from this editor | Allow | This is the local source of truth. |
| Non-user patch preserves editor content | Allow | Remote content is additive or compatible with local editor state. |
| Destructive patch, no recent local typing | Allow | The open editor is passive; blocking would resurrect stale state. |
| Destructive patch, recent local typing | Shield | Prevent stale repair/provider state from overwriting active input. |
| Same note open on another idle device | Allow remote updates | Open-only blocking causes cross-device deadlock. |
| Same note actively typed on both devices | Let Yjs handle normal collaboration; shield only destructive non-user replacement | Avoid replacing CRDT semantics with plugin string merge. |

## Shield Behavior

The shield is narrow:

- It runs in `EditorBindingManager.filterRiskyNonUserPatch`.
- It only considers non-user document changes.
- It only applies when incoming content does not preserve current editor
  content.
- It only applies when `lastEditorDocChangeAtMs` is inside the recent typing
  window.
- It temporarily detaches the yCollab compartment before the destructive patch
  can reach CodeMirror, writes the editor authority back to Y.Text with
  `ORIGIN_EDITOR_AUTHORITY_SHIELD`, then rebinds.

This is intentionally not a general conflict resolver. It is a last-second
guard against active typing loss.

## Last-Resort Escalation

If the narrow recent-typing shield still allows stale state to overwrite
active editing in production, the next escalation is file-scoped binding
withdrawal:

1. When a destructive patch targets a recently typed binding, detach the
   editor binding for that path.
2. Clear local cursor/awareness for that path while detached.
3. Keep the editor local until either the user idles, the file loses focus, or
   a manual/automatic reconciliation path can safely choose an authority.
4. Rebind only after editor content and Y.Text content are known to match, or
   after a conflict artifact has preserved the losing side.

This escalation is intentionally a last resort because it reduces live
collaboration quality and can hide remote cursor presence. It should not be the
default policy.

## Tests That Pin The Policy

The policy is covered by:

- `tests/editor-binding-recent-activity.ts`
  - destructive local repair patch is blocked during recent typing
  - provider-origin preserving patch is allowed
  - provider-origin destructive patch is blocked during recent typing
  - provider-origin destructive patch is allowed when the editor is idle
- `tests/editor-binding-health-regressions.mjs`
  - filtering does not attempt live 3-way auto-merge
  - destructive patch shielding depends on recent editor activity
  - patch capture does not store a live merge base

When changing this policy, update this document and those tests together.
