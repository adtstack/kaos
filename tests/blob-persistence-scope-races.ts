import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	BlobAuthorityScopeGuard,
	buildBlobAuthorityScopeIdentity,
	canonicalizeBlobAuthorityScope,
	type BlobAuthorityEnsureToken,
	type BlobAuthorityPersistenceLane,
	type BlobAuthorityScope,
	type BlobAuthorityScopeToken,
} from "../src/sync/blobAuthorityScopeGuard";
import {
	createPersistedBlobQueueSnapshot,
	readPersistedBlobQueueSnapshot,
} from "../src/sync/persistedBlobQueue";
import type { BlobQueueSnapshot } from "../src/sync/blobSync";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"];
	let reject!: Deferred<T>["reject"];
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(rounds = 4): Promise<void> {
	for (let index = 0; index < rounds; index++) await Promise.resolve();
}

interface ScopedPendingValue {
	id: string;
	scope: BlobAuthorityScope;
}

type SettledValue = Record<string, string>;

class DeferredStore<T> {
	readonly saves: T[] = [];
	readonly saveGates: Deferred<void>[] = [];
	loadCalls = 0;
	clearCalls = 0;

	constructor(private readonly loadResult: Promise<T>) {}

	load(): Promise<T> {
		this.loadCalls++;
		return this.loadResult;
	}

	save(value: T): Promise<void> {
		this.saves.push(value);
		return this.saveGates.shift()?.promise ?? Promise.resolve();
	}

	async clear(): Promise<void> {
		this.clearCalls++;
	}
}

interface PersistenceLane<T> {
	store: DeferredStore<T> | null;
	key: string | null;
	tail: Promise<void>;
	healthy: boolean;
}

function scopeKey(scope: BlobAuthorityScope): string {
	const identity = buildBlobAuthorityScopeIdentity(scope);
	if (!identity) throw new Error("invalid test scope");
	return identity;
}

/**
 * Small deterministic model of main.ts's generation/store/tail predicates.
 * The production guard is used directly; fake stores only make every await
 * controllable so stale completions can be released in the dangerous order.
 */
class AuthorityHarness {
	readonly guard = new BlobAuthorityScopeGuard();
	scope: BlobAuthorityScope = { host: "", vaultId: "", localDeviceId: "" };
	pendingEntries: ScopedPendingValue[] = [];
	settledRefs: SettledValue = {};
	legacyMissing = new Set<string>();
	pendingRenameIds = new Set<string>();
	savedQueue: BlobQueueSnapshot | null = null;
	persistedQueue: unknown;
	mainAttention: string[] = [];
	liveAttention: string[] = [];
	revokes: string[] = [];
	logs: string[] = [];
	resetInProgress = false;
	currentVault: object | null = null;
	readonly pending: PersistenceLane<ScopedPendingValue[]> = {
		store: null,
		key: null,
		tail: Promise.resolve(),
		healthy: false,
	};
	readonly settled: PersistenceLane<SettledValue> = {
		store: null,
		key: null,
		tail: Promise.resolve(),
		healthy: false,
	};

	prime(scope: BlobAuthorityScope): void {
		this.scope = canonicalizeBlobAuthorityScope(scope);
		this.guard.activate(this.scope);
	}

	activate(
		scope: BlobAuthorityScope,
		options: { force?: boolean; detachStores?: boolean } = {},
	): { changed: boolean; token: BlobAuthorityScopeToken; scope: BlobAuthorityScope } {
		this.scope = canonicalizeBlobAuthorityScope(scope);
		const activation = this.guard.activate(this.scope, { force: options.force });
		if (!activation.changed) return activation;

		this.pending.healthy = false;
		this.settled.healthy = false;
		for (const path of Object.keys(this.settledRefs)) delete this.settledRefs[path];
		this.settledRefs = {};
		this.legacyMissing.clear();
		this.pendingRenameIds.clear();
		this.savedQueue = null;
		this.persistedQueue = undefined;
		this.mainAttention = this.mainAttention.filter((reason) => reason !== "legacy-missing");
		this.liveAttention = this.liveAttention.filter((reason) => reason !== "legacy-missing");
		if (options.detachStores !== false) {
			this.pending.store = null;
			this.pending.key = null;
			this.settled.store = null;
			this.settled.key = null;
		}
		this.revokes.push("scope-change");
		return activation;
	}

	private isCurrent(token: BlobAuthorityScopeToken): boolean {
		return this.guard.isCurrent(token, this.scope);
	}

	private isCurrentEnsure<T>(
		token: BlobAuthorityEnsureToken,
		key: string,
		store: DeferredStore<T>,
	): boolean {
		return this.guard.isCurrentEnsure(token, this.scope, key, store);
	}

	private async waitForStableTail<T>(
		lane: PersistenceLane<T>,
		token: BlobAuthorityScopeToken,
	): Promise<boolean> {
		for (;;) {
			const tail = lane.tail;
			try {
				await tail;
			} catch {
				// The next serialized write can recover a rejected predecessor.
			}
			if (!this.isCurrent(token)) return false;
			if (tail === lane.tail) return true;
		}
	}

	async ensurePending(store: DeferredStore<ScopedPendingValue[]>): Promise<boolean> {
		const activation = this.activate(this.scope);
		if (!activation.token.identity || this.resetInProgress) return false;
		const key = scopeKey(activation.scope);
		this.pending.healthy = false;
		this.pending.store = null;
		this.pending.key = null;
		const attempt = this.guard.beginEnsure("pending", activation.scope, key, store);
		if (!await this.waitForStableTail(this.pending, attempt)) return false;
		if (!this.isCurrentEnsure(attempt, key, store)) return false;
		try {
			const loaded = await store.load();
			if (!this.isCurrentEnsure(attempt, key, store)) return false;
			const foreign = this.pendingEntries.filter((entry) =>
				buildBlobAuthorityScopeIdentity(entry.scope) !== attempt.identity
			);
			this.pendingEntries = [...foreign, ...loaded];
			this.pending.store = store;
			this.pending.key = key;
			this.pending.healthy = true;
			return true;
		} catch (error) {
			if (!this.isCurrentEnsure(attempt, key, store)) return false;
			this.pending.healthy = false;
			this.logs.push(`pending-load:${String(error)}`);
			this.revokes.push("pending-load");
			return false;
		}
	}

	async ensureSettled(store: DeferredStore<SettledValue>): Promise<boolean> {
		const activation = this.activate(this.scope);
		if (!activation.token.identity || this.resetInProgress) return false;
		const key = scopeKey(activation.scope);
		this.settled.healthy = false;
		this.settled.store = null;
		this.settled.key = null;
		const attempt = this.guard.beginEnsure("settled", activation.scope, key, store);
		if (!await this.waitForStableTail(this.settled, attempt)) return false;
		if (!this.isCurrentEnsure(attempt, key, store)) return false;
		try {
			const loaded = await store.load();
			if (!this.isCurrentEnsure(attempt, key, store)) return false;
			for (const path of Object.keys(this.settledRefs)) delete this.settledRefs[path];
			Object.assign(this.settledRefs, loaded);
			this.settled.store = store;
			this.settled.key = key;
			this.settled.healthy = true;
			return true;
		} catch (error) {
			if (!this.isCurrentEnsure(attempt, key, store)) return false;
			this.settled.healthy = false;
			this.logs.push(`settled-load:${String(error)}`);
			this.revokes.push("settled-load");
			return false;
		}
	}

	private enqueue<T>(
		kind: BlobAuthorityPersistenceLane,
		lane: PersistenceLane<T>,
		value: T,
	): Promise<void> {
		const token = this.guard.capture();
		const store = lane.store;
		const key = lane.key;
		if (
			this.resetInProgress
			|| !token.identity
			|| !store
			|| key !== scopeKey(this.scope)
		) return Promise.reject(new Error(`${kind} lane unavailable`));

		lane.healthy = false;
		const write = lane.tail.catch(() => undefined).then(() => store.save(value));
		lane.tail = write;
		void write.then(
			() => {
				if (
					!this.isCurrent(token)
					|| lane.store !== store
					|| lane.key !== key
					|| lane.tail !== write
				) return;
				lane.healthy = true;
			},
			(error) => {
				if (
					!this.isCurrent(token)
					|| lane.store !== store
					|| lane.key !== key
					|| lane.tail !== write
				) return;
				lane.healthy = false;
				this.logs.push(`${kind}-save:${String(error)}`);
				this.revokes.push(`${kind}-save`);
			},
		);
		return write;
	}

	enqueuePending(value = [...this.pendingEntries]): Promise<void> {
		return this.enqueue("pending", this.pending, value);
	}

	enqueueSettled(value = { ...this.settledRefs }): Promise<void> {
		return this.enqueue("settled", this.settled, value);
	}

	async reset(): Promise<void> {
		this.resetInProgress = true;
		try {
			const activation = this.activate(this.scope, { force: true, detachStores: false });
			const pendingStore = this.pending.store;
			const settledStore = this.settled.store;
			if (!await this.waitForStableTail(this.pending, activation.token)) return;
			if (!await this.waitForStableTail(this.settled, activation.token)) return;
			await pendingStore?.clear();
			if (!this.isCurrent(activation.token)) return;
			await settledStore?.clear();
			if (!this.isCurrent(activation.token)) return;
			this.pending.store = null;
			this.pending.key = null;
			this.settled.store = null;
			this.settled.key = null;
			this.pending.healthy = false;
			this.settled.healthy = false;
			this.pendingEntries = [];
		} finally {
			this.resetInProgress = false;
		}
	}

	async replayAfter(
		gate: Promise<void>,
		vault: object,
		apply: () => void,
	): Promise<void> {
		const token = this.guard.capture();
		await gate;
		if (!this.isCurrent(token) || this.currentVault !== vault) return;
		apply();
	}
}

const SCOPE_A: BlobAuthorityScope = {
	host: "https://sync.example.test",
	vaultId: "vault-a",
	localDeviceId: "device-a",
};
const SCOPE_B: BlobAuthorityScope = {
	...SCOPE_A,
	vaultId: "vault-b",
};
const INVALID_SCOPE: BlobAuthorityScope = {
	...SCOPE_A,
	localDeviceId: "",
};

console.log("\n--- Blob authority scope: canonical generation fence ---");
{
	const guard = new BlobAuthorityScopeGuard();
	const first = guard.activate({
		host: "  https://SYNC.example.test///?ignored=1#fragment ",
		vaultId: " vault-a ",
		localDeviceId: " device-a ",
	});
	assert.equal(first.changed, true);
	assert.deepEqual(first.scope, SCOPE_A);
	const same = guard.activate(SCOPE_A);
	assert.equal(same.changed, false, "canonical aliases must retain one epoch");
	assert.equal(same.token.epoch, first.token.epoch);
	const invalid = guard.activate(INVALID_SCOPE);
	assert.equal(invalid.changed, true);
	assert.equal(invalid.token.identity, null);
	assert.equal(invalid.token.epoch, first.token.epoch + 1);
	assert.equal(guard.isCurrent(first.token, SCOPE_A), false);
}

console.log("\n--- Blob authority scope: transition revokes every scope-owned view ---");
{
	const harness = new AuthorityHarness();
	harness.activate(SCOPE_A);
	const oldRefs = harness.settledRefs;
	oldRefs["assets/a.png"] = "H1";
	harness.pending.healthy = true;
	harness.settled.healthy = true;
	harness.pending.store = new DeferredStore(Promise.resolve([]));
	harness.pending.key = scopeKey(SCOPE_A);
	harness.settled.store = new DeferredStore(Promise.resolve({}));
	harness.settled.key = scopeKey(SCOPE_A);
	harness.legacyMissing.add("assets/missing.png");
	harness.pendingRenameIds.add("rename-a");
	harness.savedQueue = { uploads: [{ path: "assets/a.png" }], downloads: [] };
	harness.persistedQueue = { foreign: false };
	harness.mainAttention = ["other", "legacy-missing"];
	harness.liveAttention = ["legacy-missing", "other"];

	const transitioned = harness.activate(SCOPE_B);
	assert.equal(transitioned.changed, true);
	assert.deepEqual(oldRefs, {}, "the object captured by the old BlobSync is cleared in place");
	assert.notEqual(harness.settledRefs, oldRefs, "the new scope receives a fresh refs object");
	assert.equal(harness.pending.healthy, false);
	assert.equal(harness.settled.healthy, false);
	assert.equal(harness.pending.store, null);
	assert.equal(harness.settled.store, null);
	assert.equal(harness.savedQueue, null);
	assert.equal(harness.persistedQueue, undefined);
	assert.deepEqual(harness.mainAttention, ["other"]);
	assert.deepEqual(harness.liveAttention, ["other"]);
	assert.equal(harness.legacyMissing.size, 0);
	assert.equal(harness.pendingRenameIds.size, 0);

	const invalidated = harness.activate(INVALID_SCOPE);
	assert.equal(invalidated.changed, true);
	assert.equal(invalidated.token.identity, null);
	assert.equal(harness.pending.healthy, false);
	assert.equal(harness.settled.healthy, false);
}

console.log("\n--- Blob authority startup: same-scope persisted queue survives priming ---");
{
	const queue: BlobQueueSnapshot = {
		uploads: [],
		downloads: [{
			path: "assets/a.png",
			hash: "a".repeat(64),
			sizeBytes: 7,
			acceptableLocalHashes: undefined,
		}],
	};
	const persisted = createPersistedBlobQueueSnapshot(queue, SCOPE_A);
	const harness = new AuthorityHarness();
	harness.persistedQueue = persisted;
	harness.prime(SCOPE_A);
	harness.savedQueue = readPersistedBlobQueueSnapshot(harness.persistedQueue, harness.scope);
	const firstRuntimeApply = harness.activate(SCOPE_A);
	assert.equal(firstRuntimeApply.changed, false);
	assert.deepEqual(harness.savedQueue, queue);
}

console.log("\n--- Blob authority loads: delayed A cannot install over B ---");
{
	const harness = new AuthorityHarness();
	harness.activate(SCOPE_A);
	harness.pendingEntries = [{ id: "foreign-b", scope: SCOPE_B }];
	const loadA = deferred<ScopedPendingValue[]>();
	const storeA = new DeferredStore(loadA.promise);
	const ensureA = harness.ensurePending(storeA);
	await flushMicrotasks();
	assert.equal(storeA.loadCalls, 1);

	harness.activate(SCOPE_B);
	const storeB = new DeferredStore(Promise.resolve([{ id: "current-b", scope: SCOPE_B }]));
	assert.equal(await harness.ensurePending(storeB), true);
	loadA.resolve([{ id: "stale-a", scope: SCOPE_A }]);
	assert.equal(await ensureA, false);
	assert.deepEqual(harness.pendingEntries.map((entry) => entry.id), ["current-b"]);
	assert.equal(harness.pending.store, storeB);
	assert.equal(harness.pending.healthy, true);
	assert.deepEqual(harness.logs, []);
}

console.log("\n--- Blob authority settled refs: delayed H1 cannot overwrite B's H2 ---");
{
	const harness = new AuthorityHarness();
	harness.activate(SCOPE_A);
	const loadA = deferred<SettledValue>();
	const storeA = new DeferredStore(loadA.promise);
	const ensureA = harness.ensureSettled(storeA);
	await flushMicrotasks();
	assert.equal(storeA.loadCalls, 1);

	harness.activate(SCOPE_B);
	const storeB = new DeferredStore(Promise.resolve({ "assets/a.png": "H2" }));
	assert.equal(await harness.ensureSettled(storeB), true);
	loadA.resolve({ "assets/a.png": "H1" });
	assert.equal(await ensureA, false);
	assert.deepEqual(harness.settledRefs, { "assets/a.png": "H2" });
	assert.equal(harness.settled.store, storeB);
	assert.equal(harness.settled.healthy, true);
}

console.log("\n--- Blob authority saves: stale A success and failure are silent in B ---");
for (const outcome of ["success", "failure"] as const) {
	const harness = new AuthorityHarness();
	harness.activate(SCOPE_A);
	const saveA = deferred<void>();
	const storeA = new DeferredStore<ScopedPendingValue[]>(Promise.resolve([]));
	storeA.saveGates.push(saveA);
	assert.equal(await harness.ensurePending(storeA), true);
	const writeA = harness.enqueuePending([{ id: `write-a-${outcome}`, scope: SCOPE_A }]);
	await flushMicrotasks();

	harness.activate(SCOPE_B);
	const storeB = new DeferredStore<ScopedPendingValue[]>(Promise.resolve([
		{ id: `loaded-b-${outcome}`, scope: SCOPE_B },
	]));
	const ensureB = harness.ensurePending(storeB);
	if (outcome === "success") {
		saveA.resolve(undefined);
		await writeA;
	} else {
		saveA.reject(new Error("A failed late"));
		await assert.rejects(writeA, /failed late/);
	}
	assert.equal(await ensureB, true);
	assert.equal(harness.pending.store, storeB);
	assert.equal(harness.pending.healthy, true);
	assert.deepEqual(harness.logs, [], `${outcome}: stale A must not log against B`);
	assert.equal(
		harness.revokes.filter((reason) => reason === "pending-save").length,
		0,
		`${outcome}: stale A must not revoke B`,
	);
}

console.log("\n--- Blob authority write lane: only exact latest W2 reopens health ---");
{
	const harness = new AuthorityHarness();
	harness.activate(SCOPE_A);
	const store = new DeferredStore<ScopedPendingValue[]>(Promise.resolve([]));
	assert.equal(await harness.ensurePending(store), true);
	const w1Gate = deferred<void>();
	const w2Gate = deferred<void>();
	store.saveGates.push(w1Gate, w2Gate);
	const w1 = harness.enqueuePending([{ id: "W1", scope: SCOPE_A }]);
	const w2 = harness.enqueuePending([{ id: "W2", scope: SCOPE_A }]);
	assert.equal(harness.pending.healthy, false);
	w1Gate.resolve(undefined);
	await w1;
	await flushMicrotasks();
	assert.equal(harness.pending.healthy, false, "W1 cannot overtake queued W2");
	w2Gate.resolve(undefined);
	await w2;
	await flushMicrotasks();
	assert.equal(harness.pending.healthy, true, "only latest current W2 reopens health");
}
{
	const harness = new AuthorityHarness();
	harness.activate(SCOPE_A);
	const store = new DeferredStore<ScopedPendingValue[]>(Promise.resolve([]));
	assert.equal(await harness.ensurePending(store), true);
	const w1Gate = deferred<void>();
	const w2Gate = deferred<void>();
	store.saveGates.push(w1Gate, w2Gate);
	const w1 = harness.enqueuePending([{ id: "W1", scope: SCOPE_A }]);
	const w2 = harness.enqueuePending([{ id: "W2", scope: SCOPE_A }]);
	w1Gate.resolve(undefined);
	await w1;
	w2Gate.reject(new Error("W2 current failure"));
	await assert.rejects(w2, /W2 current failure/);
	await flushMicrotasks();
	assert.equal(harness.pending.healthy, false);
	assert.equal(harness.logs.filter((line) => line.startsWith("pending-save:")).length, 1);
	assert.equal(harness.revokes.filter((reason) => reason === "pending-save").length, 1);
}

console.log("\n--- Blob authority ensure: latest same-scope attempt and ABA epoch win ---");
{
	const harness = new AuthorityHarness();
	harness.activate(SCOPE_A);
	const l1 = deferred<ScopedPendingValue[]>();
	const l2 = deferred<ScopedPendingValue[]>();
	const store1 = new DeferredStore(l1.promise);
	const store2 = new DeferredStore(l2.promise);
	const ensure1 = harness.ensurePending(store1);
	await flushMicrotasks();
	assert.equal(store1.loadCalls, 1);
	const ensure2 = harness.ensurePending(store2);
	await flushMicrotasks();
	assert.equal(store2.loadCalls, 1);
	l1.resolve([{ id: "L1", scope: SCOPE_A }]);
	l2.resolve([{ id: "L2", scope: SCOPE_A }]);
	assert.equal(await ensure1, false);
	assert.equal(await ensure2, true);
	assert.equal(harness.pending.store, store2);
	assert.deepEqual(harness.pendingEntries.map((entry) => entry.id), ["L2"]);
}
{
	const harness = new AuthorityHarness();
	harness.activate(SCOPE_A);
	const oldA = deferred<SettledValue>();
	const oldStoreA = new DeferredStore(oldA.promise);
	const oldEnsureA = harness.ensureSettled(oldStoreA);
	await flushMicrotasks();
	harness.activate(SCOPE_B);
	assert.equal(
		await harness.ensureSettled(new DeferredStore(Promise.resolve({ "assets/a.png": "H2" }))),
		true,
	);
	harness.activate(SCOPE_A);
	const newStoreA = new DeferredStore(Promise.resolve({ "assets/a.png": "H3" }));
	assert.equal(await harness.ensureSettled(newStoreA), true);
	oldA.resolve({ "assets/a.png": "H1" });
	assert.equal(await oldEnsureA, false);
	assert.deepEqual(harness.settledRefs, { "assets/a.png": "H3" });
	assert.equal(harness.settled.store, newStoreA);
}

console.log("\n--- Blob authority replay: stale scope or VaultSync cannot mutate CRDT ---");
{
	const harness = new AuthorityHarness();
	harness.activate(SCOPE_A);
	const vaultA = {};
	harness.currentVault = vaultA;
	const discovery = deferred<void>();
	let applied = 0;
	const replay = harness.replayAfter(discovery.promise, vaultA, () => applied++);
	harness.activate(SCOPE_B);
	harness.currentVault = {};
	discovery.resolve(undefined);
	await replay;
	assert.equal(applied, 0);
}

console.log("\n--- Blob runtime authority: A to B to A cannot revive an old epoch ---");
{
	const guard = new BlobAuthorityScopeGuard();
	const oldVaultA = {};
	const currentVaultA = {};
	const bindings = new WeakMap<object, BlobAuthorityScopeToken>();
	const oldA = guard.activate(SCOPE_A).token;
	bindings.set(oldVaultA, oldA);
	guard.activate(SCOPE_B);
	const currentA = guard.activate(SCOPE_A).token;
	bindings.set(currentVaultA, currentA);
	const isBound = (vault: object, token: BlobAuthorityScopeToken): boolean => {
		const bound = bindings.get(vault);
		return !!bound
			&& bound.identity === token.identity
			&& bound.epoch === token.epoch
			&& guard.isCurrent(token, SCOPE_A);
	};
	assert.equal(isBound(oldVaultA, oldA), false, "old A epoch must remain stale");
	assert.equal(isBound(currentVaultA, currentA), true, "new A epoch owns authority");
}
{
	const harness = new AuthorityHarness();
	harness.activate(SCOPE_A);
	const vaultA = {};
	harness.currentVault = vaultA;
	const flush = deferred<void>();
	let applied = 0;
	const replay = harness.replayAfter(flush.promise, vaultA, () => applied++);
	harness.currentVault = {};
	flush.resolve(undefined);
	await replay;
	assert.equal(applied, 0, "same-scope replacement VaultSync also fences replay");
}

console.log("\n--- Blob authority reset: old tail settles before clear and cannot resurrect ---");
{
	const harness = new AuthorityHarness();
	harness.activate(SCOPE_A);
	const pendingStore = new DeferredStore<ScopedPendingValue[]>(Promise.resolve([]));
	const settledStore = new DeferredStore<SettledValue>(Promise.resolve({ "assets/a.png": "H1" }));
	assert.equal(await harness.ensurePending(pendingStore), true);
	assert.equal(await harness.ensureSettled(settledStore), true);
	const oldSave = deferred<void>();
	pendingStore.saveGates.push(oldSave);
	const oldWrite = harness.enqueuePending([{ id: "old-write", scope: SCOPE_A }]);
	await flushMicrotasks();
	const reset = harness.reset();
	await flushMicrotasks();
	assert.equal(pendingStore.clearCalls, 0, "reset waits for the stable old write tail");
	oldSave.resolve(undefined);
	await oldWrite;
	await reset;
	assert.equal(pendingStore.clearCalls, 1);
	assert.equal(settledStore.clearCalls, 1);
	assert.equal(harness.pending.healthy, false);
	assert.equal(harness.settled.healthy, false);
	assert.equal(harness.pending.store, null);
	assert.equal(harness.settled.store, null);
	assert.equal(harness.revokes.filter((reason) => reason === "pending-save").length, 0);
}

console.log("\n--- Blob authority production wiring ---");
{
	const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
	const orchestrator = readFileSync(
		new URL("../src/runtime/attachmentOrchestrator.ts", import.meta.url),
		"utf8",
	);
	const loadSettings = source.slice(
		source.indexOf("async loadSettings()"),
		source.indexOf("async saveSettings("),
	);
	assert.ok(
		loadSettings.indexOf("this.blobAuthorityScopeGuard.activate(this.getBlobIntentScope())")
			< loadSettings.indexOf("readPersistedBlobQueueSnapshot("),
		"startup primes the guard before the same-scope queue is read",
	);
	const runtimeApply = source.slice(
		source.indexOf("private applyRuntimeSettings("),
		source.indexOf("get serverAuthMode"),
	);
	assert.ok(
		runtimeApply.indexOf("this.runtimeConfig = buildRuntimeConfig")
			< runtimeApply.indexOf("this.activateBlobAuthorityScope"),
	);
	assert.equal(
		(source.match(/pendingBlobIntentPersistChain: Promise<void> = Promise\.resolve\(\)/g) ?? []).length,
		1,
		"pending write tail is initialized once and never reset",
	);
	assert.equal(
		(source.match(/blobSettledRefPersistChain: Promise<void> = Promise\.resolve\(\)/g) ?? []).length,
		1,
		"settled write tail is initialized once and never reset",
	);
	assert.match(source, /this\.savedBlobQueue = null;[\s\S]*hydrateSavedQueue\(null\)[\s\S]*delete this\.persistedState\._blobQueue/);
	assert.match(source, /LEGACY_MISSING_BLOB_ATTENTION_REASON[\s\S]*clearPreservedUnresolved/);
	const nuclearReset = source.slice(
		source.indexOf("private nuclearReset()"),
		source.indexOf("// -------------------------------------------------------------------\n\t// Helpers"),
	);
	assert.ok(nuclearReset.indexOf("force: true") < nuclearReset.indexOf("clearAllMaps()"));
	assert.match(nuclearReset, /waitForStablePendingBlobIntentTail/);
	assert.match(nuclearReset, /waitForStableBlobSettledRefTail/);
	assert.doesNotMatch(nuclearReset, /PersistChain = Promise\.resolve/);
	const runtimeAuthority = source.slice(
		source.indexOf("private isBlobRuntimeAuthorityCurrent("),
		source.indexOf("private isCurrentPendingBlobEnsure(", source.indexOf("private isBlobRuntimeAuthorityCurrent(")),
	);
	assert.ok(
		source.includes("vaultSyncBlobAuthorityTokens = new WeakMap")
			&& runtimeAuthority.includes("bound.identity === token.identity")
			&& runtimeAuthority.includes("bound.epoch === token.epoch")
			&& runtimeAuthority.includes("blobAuthorityScopeGuard.isCurrent(token, scope)"),
		"VaultSync authority is bound to the exact identity+epoch token",
	);
	assert.ok(
		orchestrator.includes("blobRuntimeAuthorities = new WeakMap")
			&& orchestrator.includes("isManagerAuthorityCurrent(blobSync)")
			&& orchestrator.includes("if (!this.isManagerAuthorityCurrent(blobSync)) return;")
			&& orchestrator.includes("isBlobRuntimeAuthorityCurrent(")
			&& orchestrator.includes("onBlobSettledRefsChanged(")
			&& orchestrator.includes('Promise.reject(new Error("Attachment manager authority changed"))'),
		"manager reconcile, gate, and settlement callbacks retain exact runtime authority",
	);
	assert.ok(
		orchestrator.includes("persistBlobQueue(")
			&& orchestrator.includes("authority.token")
			&& source.includes("blobAuthorityScopeGuard.isCurrent(token, scope)"),
		"retiring queue callbacks cannot relabel an A-to-B-to-A runtime epoch",
	);
	assert.ok(
		source.includes('vaultSync.provider.on("status"')
			&& source.includes('vaultSync.provider.on("sync"')
			&& source.includes("if (!isCurrentInitBlobAuthority()) return;")
			&& source.includes("onBlobReconciled: (mode, reconciledVaultSync)"),
		"provider/local readiness and reconciliation callbacks fail closed when stale",
	);
}

console.log("\nAll blob persistence scope-race regressions passed.");
