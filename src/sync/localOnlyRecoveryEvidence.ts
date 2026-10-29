import type { RemoteTextRevision } from "./remoteTextRevisionTracker";
import { normalizeEditorText } from "../utils/editorTextNormalization";
import type { LocalOnlyRecoveryBlockDetail } from "../observability/recoveryEventTypes";

export type RecoveryEditorSource = "local" | "projection" | "reload" | "unknown";
export interface LocalOnlyPaneEvidence {
	readonly identity: object;
	readonly scope: object;
	readonly authorityRevision: number;
	readonly remoteRevision: number;
	readonly editorRevision: number;
	readonly content: string;
	readonly localSuccessor: boolean;
	readonly origin: "chain" | "unbound-fallback";
	readonly baseContent?: string | null;
}

/** Latest checkpoint and successor only. Never stores an editing history. */
export class LocalOnlyRecoveryEvidence {
	private current: LocalOnlyPaneEvidence | null = null;

	update(input: {
		identity: object;
		revision: RemoteTextRevision | null;
		before: string | null;
		editor: string;
		crdt: string;
		source: RecoveryEditorSource;
		complete: boolean;
		normalized?: boolean;
	}): void {
		const { revision, identity } = input;
		if (!revision || !input.complete) { this.current = null; return; }
		const editor = input.normalized ? input.editor : normalizeEditorText(input.editor);
		const previous = this.current;
		const editorRevision = (previous?.editorRevision ?? 0) + 1;
		if (editor === (input.normalized ? input.crdt : normalizeEditorText(input.crdt))) {
			this.current = Object.freeze({ identity, scope: revision.scope,
				authorityRevision: revision.authorityRevision, remoteRevision: revision.remoteRevision,
				editorRevision, content: editor, localSuccessor: false, origin: "chain" });
			return;
		}
		if (input.source !== "local" || !previous || previous.identity !== identity ||
			previous.scope !== revision.scope || previous.authorityRevision !== revision.authorityRevision ||
			input.before === null || (input.normalized ? input.before : normalizeEditorText(input.before)) !== previous.content) {
			this.current = null;
			return;
		}
		this.current = Object.freeze({ ...previous, editorRevision, content: editor, localSuccessor: true, origin: "chain" });
	}

	get(): LocalOnlyPaneEvidence | null { return this.current; }
	invalidate(): void { this.current = null; }
}

export function localOnlyRecoveryBlockReason(
	revision: RemoteTextRevision | null,
	panes: readonly (LocalOnlyPaneEvidence | null)[],
	contents: readonly string[],
): LocalOnlyRecoveryBlockDetail | null {
	if (!revision) return "initial-authority-unverified";
	if (panes.length === 0 || panes.length !== contents.length) return "pane-identity-mismatch";
	for (let i = 0; i < panes.length; i++) {
		const pane = panes[i];
		if (!pane) return "initial-authority-unverified";
		if (pane.scope !== revision.scope) return "pane-identity-mismatch";
		if (pane.remoteRevision !== revision.remoteRevision) return "remote-not-acknowledged";
		if (pane.authorityRevision !== revision.authorityRevision) return "source-unverified";
		if (!pane.localSuccessor || pane.content !== normalizeEditorText(contents[i] ?? "")) return "source-unverified";
	}
	return null;
}
