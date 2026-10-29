import { HeadlessEventEmitter } from "./events";
import { unsupported } from "./strictCompat";

export class HeadlessWorkspace extends HeadlessEventEmitter {
	layoutReady = true;

	onLayoutReady(callback: () => void): void {
		queueMicrotask(callback);
	}

	getActiveViewOfType(): null {
		return null;
	}

	iterateAllLeaves(): void {}

	iterateRootLeaves(): void {}

	getLeavesOfType(): unknown[] {
		return [];
	}

	getLeaf(): unknown {
		return {
			getViewState: () => ({ type: "empty" }),
			setViewState: async () => undefined,
		};
	}

	async revealLeaf(): Promise<void> {}

	updateOptions(): void {}

	on(name: string, callback: (...args: any[]) => void) {
		// Menu events are pure UI registrations whose callbacks never fire on the
		// headless host; registering them keeps plugin sync initialization alive.
		if (
			name === "layout-change" ||
			name === "active-leaf-change" ||
			name === "file-open" ||
			name === "file-menu" ||
			name === "editor-menu"
		) {
			return super.on(name, callback);
		}
		return unsupported(`workspace.on(${name})`);
	}
}

