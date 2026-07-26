import { isKaosExcludeFilePath } from "../sync/exclude";

export interface RemoteProjectionPolicyLease {
	readonly generation: number;
	readonly closeEpoch: number;
	readonly paths: readonly string[];
}

/**
 * Provider-generation gate for CRDT-to-disk projection.
 *
 * This state is intentionally separate from path syncability: local disk and
 * editor ingress remain available while a provider generation establishes its
 * shared control policy.
 */
export class RemoteProjectionPolicyGate {
	private generation = 0;
	private ready: number | null = null;
	/**
	 * Monotonic ABA fence. A reconnect can close and reopen the same provider
	 * generation in tests or during duplicate status delivery; generation alone
	 * must never make an older operation current again.
	 */
	private closeEpoch = 0;
	private readonly activeCriticalSections = new Map<number, number>();
	private pendingOpenRetry: {
		generation: number;
		closeEpoch: number;
		callback: () => void;
	} | null = null;

	get currentGeneration(): number {
		return this.generation;
	}

	get readyGeneration(): number | null {
		return this.ready;
	}

	close(generation: number): void {
		if (generation < this.generation) return;
		this.generation = generation;
		this.ready = null;
		this.closeEpoch += 1;
		this.pendingOpenRetry = null;
	}

	open(generation: number, onCriticalSectionsDrained?: () => void): boolean {
		if (generation !== this.generation) return false;
		if (this.hasStaleCriticalSections()) {
			this.ready = null;
			this.pendingOpenRetry = onCriticalSectionsDrained
				? {
					generation,
					closeEpoch: this.closeEpoch,
					callback: onCriticalSectionsDrained,
				}
				: null;
			return false;
		}
		this.pendingOpenRetry = null;
		this.ready = generation;
		return true;
	}

	isRemoteProjectionAllowed(path: string): boolean {
		return isKaosExcludeFilePath(path) || this.ready === this.generation;
	}

	captureLease(paths: readonly string[]): RemoteProjectionPolicyLease | null {
		const capturedPaths = Object.freeze([...paths]);
		if (
			capturedPaths.length === 0 ||
			!capturedPaths.every((path) => this.isRemoteProjectionAllowed(path))
		) {
			return null;
		}
		return Object.freeze({
			generation: this.generation,
			closeEpoch: this.closeEpoch,
			paths: capturedPaths,
		});
	}

	isLeaseCurrent(lease: RemoteProjectionPolicyLease): boolean {
		return lease.generation === this.generation
			&& lease.closeEpoch === this.closeEpoch
			&& lease.paths.length > 0
			&& lease.paths.every((path) => this.isRemoteProjectionAllowed(path));
	}

	/**
	 * Pin the provider epoch around an asynchronous filesystem primitive.
	 *
	 * A close still invalidates the lease immediately, but the next provider
	 * generation cannot reopen until every primitive admitted by the older
	 * epoch has settled. This is the cancellation boundary that async Obsidian
	 * trash/rename/create APIs do not otherwise provide.
	 */
	enterCriticalSection(
		lease: RemoteProjectionPolicyLease,
	): (() => void) | null {
		if (!this.isLeaseCurrent(lease)) return null;
		const epoch = lease.closeEpoch;
		this.activeCriticalSections.set(
			epoch,
			(this.activeCriticalSections.get(epoch) ?? 0) + 1,
		);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const remaining = (this.activeCriticalSections.get(epoch) ?? 1) - 1;
			if (remaining > 0) {
				this.activeCriticalSections.set(epoch, remaining);
			} else {
				this.activeCriticalSections.delete(epoch);
			}
			this.requestPendingOpenRetryIfDrained();
		};
	}

	private hasStaleCriticalSections(): boolean {
		for (const [epoch, count] of this.activeCriticalSections) {
			if (count > 0 && epoch !== this.closeEpoch) return true;
		}
		return false;
	}

	private requestPendingOpenRetryIfDrained(): void {
		const pending = this.pendingOpenRetry;
		if (
			!pending ||
			pending.generation !== this.generation ||
			pending.closeEpoch !== this.closeEpoch ||
			this.hasStaleCriticalSections()
		) {
			return;
		}
		this.pendingOpenRetry = null;
		pending.callback();
	}
}
