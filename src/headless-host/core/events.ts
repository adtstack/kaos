export interface HeadlessEventRef {
	off(): void;
}

export type HeadlessEventCallback = (...args: any[]) => void;

export class HeadlessEventEmitter {
	private readonly listeners = new Map<string, Set<HeadlessEventCallback>>();

	on(event: string, callback: HeadlessEventCallback): HeadlessEventRef {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(callback);
		return {
			off: () => {
				set?.delete(callback);
			},
		};
	}

	offref(ref: HeadlessEventRef): void {
		ref.off();
	}

	emit(event: string, ...args: unknown[]): void {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const listener of Array.from(set)) {
			listener(...args);
		}
	}

	clear(): void {
		this.listeners.clear();
	}
}

