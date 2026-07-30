import type { MarkdownView } from "obsidian";

/**
 * File-context views such as Backlinks, Outgoing Links, and Outline expose the
 * active file but are not editable document authorities. Prefer Obsidian's
 * public view type; the editor-surface fallback supports older host shims and
 * headless fixtures that do not implement getViewType().
 */
export function isMarkdownEditorView(view: unknown): view is MarkdownView {
	if (typeof view !== "object" || view === null) return false;
	const candidate = view as {
		getViewType?: () => unknown;
		editor?: { getValue?: unknown };
	};
	if (typeof candidate.getViewType === "function") {
		try {
			return candidate.getViewType.call(view) === "markdown";
		} catch {
			return false;
		}
	}
	return typeof candidate.editor?.getValue === "function";
}
