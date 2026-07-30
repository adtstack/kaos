import { Annotation } from "./codeMirrorStateShim";

/**
 * The filesystem-only host never installs a live CodeMirror history field, but
 * the product bundle still evaluates these command exports at module load.
 * Keep their identities stable and their depth reads conservatively empty.
 */
export const historyField = Symbol("kaos-headless-cm:historyField");
export const isolateHistory = Annotation.define();

export function undoDepth(_state: unknown): number {
	return 0;
}

export function redoDepth(_state: unknown): number {
	return 0;
}
