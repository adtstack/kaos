/**
 * Minimal, duck-typed workspace view inspection shared by sync safety fences.
 *
 * Obsidian Bases are file-backed views, but they are not MarkdownView
 * instances and do not expose an Editor.  Treat any view whose `file.path`
 * matches as live file authority; callers can then distinguish readable
 * Markdown editors from opaque file views and fail closed for the latter.
 */
export interface WorkspaceFileViewHost {
	activeLeaf?: { view?: unknown } | null;
	iterateAllLeaves?: (callback: (leaf: { view?: unknown }) => void) => void;
}

export function getFileViewPath(view: unknown): string | null {
	if (typeof view !== "object" || view === null) return null;
	const file = (view as { file?: unknown }).file;
	if (typeof file !== "object" || file === null) return null;
	const path = (file as { path?: unknown }).path;
	return typeof path === "string" ? path : null;
}

export function getOpenFileViewsForPath(
	workspace: WorkspaceFileViewHost,
	path: string,
	initialViews: readonly unknown[] = [],
): unknown[] {
	const views: unknown[] = [];
	const add = (view: unknown) => {
		if (getFileViewPath(view) === path && !views.includes(view)) views.push(view);
	};
	for (const view of initialViews) add(view);
	add(workspace.activeLeaf?.view);
	workspace.iterateAllLeaves?.((leaf) => add(leaf.view));
	return views;
}
