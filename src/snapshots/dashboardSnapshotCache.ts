export const DASHBOARD_SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000;

interface DashboardSnapshotCacheOptions {
	ttlMs?: number;
	now?: () => number;
}

interface DashboardSnapshotCacheEntry<T> {
	expiresAt: number;
	value?: T;
	promise?: Promise<T>;
}

export class DashboardSnapshotCache {
	private readonly entries = new Map<string, DashboardSnapshotCacheEntry<unknown>>();

	constructor(private readonly options: DashboardSnapshotCacheOptions = {}) {}

	async get<T>(key: string, load: () => Promise<T>): Promise<T> {
		const now = this.now();
		const existing = this.entries.get(key) as DashboardSnapshotCacheEntry<T> | undefined;
		if (existing && existing.expiresAt > now) {
			if (existing.promise) return await existing.promise;
			return existing.value as T;
		}

		const promise = Promise.resolve()
			.then(load)
			.then((value) => {
				const current = this.entries.get(key);
				if (current?.promise === promise) {
					this.entries.set(key, {
						expiresAt: this.now() + this.ttlMs(),
						value,
					});
				}
				return value;
			})
			.catch((err) => {
				const current = this.entries.get(key);
				if (current?.promise === promise) {
					this.entries.delete(key);
				}
				throw err;
			});

		this.entries.set(key, {
			expiresAt: Number.POSITIVE_INFINITY,
			promise,
		});
		return await promise;
	}

	invalidate(key?: string): void {
		if (key) {
			this.entries.delete(key);
			return;
		}
		this.entries.clear();
	}

	private ttlMs(): number {
		return this.options.ttlMs ?? DASHBOARD_SNAPSHOT_CACHE_TTL_MS;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}
