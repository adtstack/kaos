/**
 * Bounded-concurrency parallel map.
 *
 * SOURCE OF TRUTH: src/shared/concurrency.ts
 *
 * This file exists because the server build boundary (server/tsconfig.json)
 * cannot import from the client src/ tree. The function body must remain
 * identical to the canonical implementation. If you change one, change both.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];

	const normalizedLimit = Math.max(1, Math.min(limit, items.length));
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	async function runWorker(): Promise<void> {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await worker(items[index] as T, index);
		}
	}

	await Promise.all(
		Array.from({ length: normalizedLimit }, () => runWorker()),
	);

	return results;
}
