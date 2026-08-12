import { type App, MarkdownView, type WorkspaceLeaf } from "obsidian";
import type { EditorBindingManager } from "../sync/editorBinding";
import type { DiskMirror } from "../sync/diskMirror";
import type { VaultSyncSettings } from "../settings";

interface EditorWorkspaceOrchestratorDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	getEditorBindings(): EditorBindingManager | null;
	getDiskMirror(): DiskMirror | null;
	isMarkdownPathSyncable(path: string): boolean;
	scheduleTraceStateSnapshot(reason: string): void;
	log(message: string): void;
}

export class EditorWorkspaceOrchestrator {
	private openFilePaths = new Set<string>();
	private activeMarkdownPath: string | null = null;

	constructor(private readonly deps: EditorWorkspaceOrchestratorDeps) {}

	get openFileCount(): number {
		return this.openFilePaths.size;
	}

	reset(): void {
		this.openFilePaths.clear();
		this.activeMarkdownPath = null;
	}

	onReconciled(reason: string): void {
		this.reconcileOpenEditors();
		this.validateOpenBindings(reason);
	}

	onLayoutChange(): void {
		this.reconcileTrackedOpenFiles("layout-change");
		this.updateActiveMarkdownPath(
			this.getActiveMarkdownPath(),
			"layout-change-active-blur",
		);
		this.validateOpenBindings("layout-change");
	}

	onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
		const view = leaf?.view instanceof MarkdownView ? leaf.view : null;
		const candidatePath = view?.file?.path ?? null;
		const nextPath = candidatePath && this.deps.isMarkdownPathSyncable(candidatePath)
			? candidatePath
			: null;
		this.updateActiveMarkdownPath(nextPath, "active-leaf-change");
		this.reconcileTrackedOpenFiles("active-leaf-change");
		if (view) {
			this.bindView(view);
		}
	}

	onFileOpen(filePath: string | null): void {
		const syncablePath =
			filePath && this.deps.isMarkdownPathSyncable(filePath) ? filePath : null;
		const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
		const leafStatePath = view ? this.getLeafStateFilePath(view) : null;
		const activeViewOwnsEvent =
			!!view
			&& !!filePath
			&& (view.file?.path === filePath || leafStatePath === filePath);
		this.updateActiveMarkdownPath(
			filePath === null
				? null
				: activeViewOwnsEvent
					? syncablePath
					: this.getActiveMarkdownPath(),
			"file-open-active-change",
		);
		const editorBindings = this.deps.getEditorBindings();
		if (view && syncablePath && activeViewOwnsEvent) {
			// Fence synchronously: file-open can precede the reused MarkdownView's
			// TFile/CodeMirror adoption, so waiting for the settled validation leaves
			// a real input window between A and B. The leaf view-state ownership check
			// excludes file-open events emitted for embeds or another leaf.
			editorBindings?.beginFileTransition(view, syncablePath);
		} else if (view && activeViewOwnsEvent) {
			editorBindings?.cancelFileTransition(view, undefined, "file-open-unsyncable");
		}
		if (!filePath) return;
		if (view && view.file?.path === filePath) {
			this.bindView(view);
		}
		// Obsidian can emit file-open before the MarkdownView has adopted its new
		// TFile. Re-scan after the current host callback settles instead of relying
		// on a private save boundary to keep the binding alive.
		queueMicrotask(() => this.validateOpenBindings("file-open-settled"));
	}

	onMarkdownDeleted(path: string): void {
		this.deps.getEditorBindings()?.unbindByPath(path);
		this.deps.getDiskMirror()?.notifyFileClosed(path);
		this.openFilePaths.delete(path);
	}

	onRenameBatchFlushed(renames: Map<string, string>): void {
		this.deps.getEditorBindings()?.updatePathsAfterRename(renames);
		for (const [oldPath, newPath] of renames) {
			if (this.activeMarkdownPath === oldPath) {
				this.activeMarkdownPath = newPath;
			}
			if (this.openFilePaths.has(oldPath)) {
				this.deps.getDiskMirror()?.notifyFileClosed(oldPath);
				this.openFilePaths.delete(oldPath);
				this.deps.getDiskMirror()?.notifyFileOpened(newPath);
				this.openFilePaths.add(newPath);
				this.deps.log(`Rename batch: moved observer "${oldPath}" -> "${newPath}"`);
			}
		}
	}

	validateOpenBindings(reason: string): void {
		let touched = 0;
		let auditNeeded = false;
		const liveMarkdownViews = new Set<MarkdownView>();
		const editorBindings = this.deps.getEditorBindings();
		if (!editorBindings) return;

		this.deps.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				liveMarkdownViews.add(leaf.view);
			}
		});
		// Expired input fences must be released or retired before the current-path
		// bind attempt. Both operations run in this callback, so user input cannot
		// enter the newly editable editor between release and reattachment.
		editorBindings.pruneFileTransitionFences(liveMarkdownViews);

		for (const view of liveMarkdownViews) {
			if (!view.file) continue;
			if (!this.deps.isMarkdownPathSyncable(view.file.path)) {
				// This can still be the briefly visible excluded source A while a
				// syncable target B owns an active same-view transition fence.
				editorBindings.unbind(view, true);
				continue;
			}

			const binding = editorBindings.getBindingDebugInfoForView(view) ?? null;
			const health = editorBindings.getBindingHealthForView(view) ?? null;

			if (health?.bound && (health.healthy || health.settling)) {
				continue;
			}

			if (!binding || !health?.bound) {
				touched += 1;
				this.bindView(view);
				continue;
			}

			auditNeeded = true;
		}

		if (auditNeeded) {
			touched += editorBindings.auditBindings(`validate:${reason}`);
		}

		if (touched > 0) {
			this.deps.log(`Validated open bindings (${reason}) — touched ${touched}`);
			this.deps.scheduleTraceStateSnapshot(`validate-open-bindings:${reason}`);
		}
	}

	auditBindings(reason: string): number {
		const touched = this.deps.getEditorBindings()?.auditBindings(reason) ?? 0;
		if (touched > 0) {
			this.deps.scheduleTraceStateSnapshot(`binding-audit:${reason}`);
		}
		return touched;
	}

	private reconcileOpenEditors(): void {
		this.deps.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				this.bindView(leaf.view);
			}
		});
		this.activeMarkdownPath = this.getActiveMarkdownPath();
	}

	private bindView(view: MarkdownView): void {
		const bindings = this.deps.getEditorBindings();
		const path = view.file?.path;
		if (!path || !this.deps.isMarkdownPathSyncable(path)) {
			// An excluded source can remain visible until the target TFile is adopted.
			// Preserve any syncable target fence announced by file-open.
			bindings?.unbind(view, true);
			return;
		}
		bindings?.bind(view, this.deps.getSettings().deviceName);
		this.trackOpenFile(path);
	}

	private trackOpenFile(path: string): void {
		if (!this.openFilePaths.has(path)) {
			this.deps.getDiskMirror()?.notifyFileOpened(path);
			this.openFilePaths.add(path);
		}

		this.reconcileTrackedOpenFiles("track-open-file");
		this.deps.scheduleTraceStateSnapshot("track-open-file");
	}

	private reconcileTrackedOpenFiles(reason: string): void {
		const currentlyOpen = new Set<string>();
		this.deps.app.workspace.iterateAllLeaves((leaf) => {
			if (
				leaf.view instanceof MarkdownView
				&& leaf.view.file
				&& this.deps.isMarkdownPathSyncable(leaf.view.file.path)
			) {
				currentlyOpen.add(leaf.view.file.path);
			}
		});

		for (const tracked of this.openFilePaths) {
			if (!currentlyOpen.has(tracked)) {
				this.deps.getDiskMirror()?.notifyFileClosed(tracked);
				this.openFilePaths.delete(tracked);
				this.deps.log(`${reason}: closed observer for "${tracked}"`);
			}
		}
	}

	private getActiveMarkdownPath(): string | null {
		const activeView = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
		const path = activeView?.file?.path;
		return path && this.deps.isMarkdownPathSyncable(path) ? path : null;
	}

	private getLeafStateFilePath(view: MarkdownView): string | null {
		try {
			const state = view.leaf.getViewState().state as { file?: unknown };
			return typeof state.file === "string" ? state.file : null;
		} catch {
			return null;
		}
	}

	private updateActiveMarkdownPath(nextPath: string | null, reason: string): void {
		const previousPath = this.activeMarkdownPath;
		this.activeMarkdownPath = nextPath;

		if (!previousPath || previousPath === nextPath) {
			return;
		}

		this.deps.getEditorBindings()?.clearLocalCursor(reason);
	}
}
