import * as Y from "yjs";
import type { MarkdownView } from "obsidian";
import { normalizeEditorText } from "../../src/utils/editorTextNormalization";
import type { RemoteTextRevision } from "../../src/sync/remoteTextRevisionTracker";
import type { LocalOnlyPaneEvidence } from "../../src/sync/localOnlyRecoveryEvidence";

/** Explicit source-proof stub for legacy orchestration tests that already assume
 * a local edit after convergence. Not suitable for provider/hydration/race tests
 * of admission itself: those must use the real tracker and evidence collector. */
export function createCertifiedLocalRecoveryFixture(getText: () => Y.Text | null) {
 const scopes = new WeakMap<Y.Text, RemoteTextRevision>();
 const panes = new WeakMap<MarkdownView, LocalOnlyPaneEvidence>();
 const revision = (): RemoteTextRevision | null => {
  const text = getText(); if (!text) return null;
  let value = scopes.get(text);
  if (!value) {
   value = Object.freeze({scope:{},fileId:"certified-fixture",text,textRevision:0,remoteRevision:0,authorityRevision:0,source:"editor" as const});
   scopes.set(text,value);
  }
  return value;
 };
 return {
  revision,
  pane: (view: MarkdownView): LocalOnlyPaneEvidence | null => {
   const current = revision(); if (!current) return null;
   const content = normalizeEditorText(view.editor.getValue());
   const previous = panes.get(view);
   if (previous?.scope === current.scope && previous.content === content) return previous;
   const value = Object.freeze({identity:view,scope:current.scope,authorityRevision:0,remoteRevision:0,editorRevision:0,content,localSuccessor:true});
   panes.set(view,value); return value;
  },
 };
}
