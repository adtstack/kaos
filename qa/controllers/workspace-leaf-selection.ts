export type WorkspaceLeafLike = Readonly<{
	view?: Readonly<{
		file?: Readonly<{ path?: unknown }>;
		getViewType?: () => unknown;
		editor?: Readonly<{ getValue?: unknown }>;
	}>;
}>;

export function isMarkdownEditorLeafForPath(
	leaf: WorkspaceLeafLike | null | undefined,
	path: string,
): boolean {
	const view = leaf?.view;
	if (view?.file?.path !== path) return false;
	if (typeof view.getViewType === "function") {
		try {
			return view.getViewType() === "markdown";
		} catch {
			return false;
		}
	}
	return typeof view.editor?.getValue === "function";
}
