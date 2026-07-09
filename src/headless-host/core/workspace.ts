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
		if (
			name === "layout-change" ||
			name === "active-leaf-change" ||
			name === "file-open"
		) {
			return super.on(name, callback);
		}
		return unsupported(`workspace.on(${name})`);
	}
}

