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
		this.updateActiveMarkdownPath(
			filePath && this.deps.isMarkdownPathSyncable(filePath) ? filePath : null,
			"file-open-active-change",
		);
		if (!filePath) return;
		const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
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
		const editorBindings = this.deps.getEditorBindings();
		if (!editorBindings) return;

		this.deps.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) {
				return;
			}
			if (!this.deps.isMarkdownPathSyncable(leaf.view.file.path)) {
				editorBindings.unbind(leaf.view);
				return;
			}

			const binding = editorBindings.getBindingDebugInfoForView(leaf.view) ?? null;
			const health = editorBindings.getBindingHealthForView(leaf.view) ?? null;

			if (health?.bound && (health.healthy || health.settling)) {
				return;
			}

			if (!binding || !health?.bound) {
				touched += 1;
				this.bindView(leaf.view);
				return;
			}

			auditNeeded = true;
		});

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
			bindings?.unbind(view);
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

	private updateActiveMarkdownPath(nextPath: string | null, reason: string): void {
		const previousPath = this.activeMarkdownPath;
		this.activeMarkdownPath = nextPath;

		if (!previousPath || previousPath === nextPath) {
			return;
		}

		this.deps.getEditorBindings()?.clearLocalCursor(reason);
	}
}
