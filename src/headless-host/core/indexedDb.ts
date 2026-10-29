import { IDBFactory } from "fake-indexeddb";

interface RetainedTransaction extends IDBTransaction {
	_rollbackLog: unknown[];
	db: IDBDatabase & { _rawDatabase: { transactions: RetainedTransaction[] } };
}

/**
 * fake-indexeddb 6.2.5 retains finished transactions, including rollback
 * closures holding overwritten snapshots. Browser IndexedDB does not have
 * this problem. Keep the workaround confined to the headless factory.
 */
export function createHeadlessIndexedDbFactory(): IDBFactory {
	const factory = new IDBFactory();
	const wrapped = new WeakSet<IDBDatabase>();
	const tracked = new WeakSet<IDBTransaction>();
	const track = (transaction: IDBTransaction | null): void => {
		if (!transaction || tracked.has(transaction)) return;
		tracked.add(transaction);
		const cleanup = (): void => {
			// Defer until abort rollback and all completion handlers have run.
			queueMicrotask(() => {
				const retained = transaction as RetainedTransaction;
				const database = retained.db._rawDatabase;
				database.transactions = database.transactions.filter((item) => item !== retained);
				retained._rollbackLog.length = 0;
			});
		};
		transaction.addEventListener("complete", cleanup, { once: true });
		transaction.addEventListener("abort", cleanup, { once: true });
	};
	const wrap = (database: IDBDatabase): void => {
		if (wrapped.has(database)) return;
		wrapped.add(database);
		const transaction = database.transaction.bind(database);
		database.transaction = (...args: Parameters<IDBDatabase["transaction"]>) => {
			const result = transaction(...args);
			track(result);
			return result;
		};
	};
	const open = factory.open.bind(factory);
	factory.open = (...args: Parameters<IDBFactory["open"]>) => {
		const request = open(...args);
		request.addEventListener("upgradeneeded", () => {
			wrap(request.result);
			track(request.transaction);
		});
		request.addEventListener("success", () => wrap(request.result));
		return request;
	};
	return factory;
}
