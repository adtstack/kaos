import assert from "node:assert/strict";
import { ConnectionController } from "../src/runtime/connectionController";
import { ReconciliationController } from "../src/runtime/reconciliationController";

Object.defineProperty(globalThis, "__KAOS_QA_HARNESS_ENABLED__", {
	configurable: true,
	value: false,
});

type Listener = () => void;

function eventTarget() {
	const listeners = new Map<string, Set<Listener>>();
	return {
		addEventListener(type: string, listener: Listener) {
			const bucket = listeners.get(type) ?? new Set<Listener>();
			bucket.add(listener);
			listeners.set(type, bucket);
		},
		removeEventListener(type: string, listener: Listener) {
			listeners.get(type)?.delete(listener);
		},
	};
}

const fakeDocument = Object.assign(eventTarget(), { visibilityState: "visible" });
const fakeWindow = eventTarget();
Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });

function fixture() {
	let providerSyncHandler: ((generation: number) => void) | null = null;
	let reconciled = false;
	let awaitingFirstSync = true;
	let reconcileInFlight = true;
	let pendingMarks = 0;
	const reconnectRuns: number[] = [];
	const logs: string[] = [];
	const sync = {
		connected: true,
		localReady: true,
		fatalAuthError: false,
		fatalAuthCode: null,
		connectionGeneration: 7,
		provider: {
			on: () => {},
			disconnect: () => {},
			connect: async () => {},
			wsconnecting: false,
		},
		onProviderSync(handler: (generation: number) => void) {
			providerSyncHandler = handler;
		},
	} as any;
	const controller = new ConnectionController({
		getVaultSync: () => sync,
		isReconciled: () => reconciled,
		getAwaitingFirstProviderSyncAfterStartup: () => awaitingFirstSync,
		setAwaitingFirstProviderSyncAfterStartup: (value) => { awaitingFirstSync = value; },
		getLastReconciledGeneration: () => 0,
		setReconnectPending: () => { pendingMarks++; },
		isReconcileInFlight: () => reconcileInFlight,
		runReconnectReconciliation: (generation) => { reconnectRuns.push(generation); },
		refreshServerCapabilities: () => {},
		flushOpenWrites: () => {},
		updateOfflineStatus: () => {},
		refreshStatusBar: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: (message) => { logs.push(message); },
		trace: () => {},
		registerCleanup: () => {},
	});
	controller.start();
	return {
		controller,
		emitProviderSync(generation: number) {
			assert.ok(providerSyncHandler, "provider sync listener is installed");
			providerSyncHandler!(generation);
		},
		setReconciled(value: boolean) { reconciled = value; },
		setAwaiting(value: boolean) { awaitingFirstSync = value; },
		setInFlight(value: boolean) { reconcileInFlight = value; },
		get awaiting() { return awaitingFirstSync; },
		get pendingMarks() { return pendingMarks; },
		reconnectRuns,
		logs,
	};
}

console.log("\n--- ConnectionController startup provider-sync race ---");

{
	const fx = fixture();
	fx.emitProviderSync(7);
	assert.equal(fx.pendingMarks, 1, "first sync during conservative startup marks a follow-up reconcile");
	assert.equal(fx.awaiting, false, "the observed first sync edge is consumed exactly once");
	assert.deepEqual(fx.reconnectRuns, [], "startup does not start a competing reconcile while one is active");
	assert.match(fx.logs.at(-1) ?? "", /authoritative catch-up pending/);
	fx.controller.stop();
}

{
	const fx = fixture();
	fx.setAwaiting(false);
	fx.emitProviderSync(7);
	assert.equal(fx.pendingMarks, 0, "unrelated pre-startup sync remains ignored without the timeout sentinel");
	fx.controller.stop();
}

{
	const fx = fixture();
	fx.setReconciled(true);
	fx.setInFlight(false);
	fx.emitProviderSync(8);
	assert.deepEqual(fx.reconnectRuns, [8], "late first sync after startup runs authoritative reconciliation directly");
	assert.equal(fx.awaiting, false);
	fx.controller.stop();
}

console.log("\n--- Startup pending sync is consumed by authoritative reconciliation ---");

{
	let providerSyncHandler: ((generation: number) => void) | null = null;
	let providerSynced = false;
	let connectionGeneration = 7;
	let awaitingFirstSync = true;
	let firstSaveStartedResolve!: () => void;
	let firstSaveReleaseResolve!: () => void;
	let authoritativeCompleteResolve!: () => void;
	const firstSaveStarted = new Promise<void>((resolve) => { firstSaveStartedResolve = resolve; });
	const firstSaveRelease = new Promise<void>((resolve) => { firstSaveReleaseResolve = resolve; });
	const authoritativeComplete = new Promise<void>((resolve) => { authoritativeCompleteResolve = resolve; });
	const reconcileModes: string[] = [];
	const reconciledReasons: string[] = [];
	let saveCalls = 0;
	let diskIndex = {};

	const sync = {
		connected: true,
		localReady: true,
		fatalAuthError: false,
		fatalAuthCode: null,
		get providerSynced() { return providerSynced; },
		get connectionGeneration() { return connectionGeneration; },
		getSafeReconcileMode: () => providerSynced ? "authoritative" : "conservative",
		provider: {
			on: () => {},
			disconnect: () => {},
			connect: async () => {},
			wsconnecting: false,
		},
		onProviderSync(handler: (generation: number) => void) {
			providerSyncHandler = handler;
		},
		getActiveMarkdownPaths: () => [],
		reconcileVault: (
			_diskFiles: Map<string, string>,
			_diskPresentPaths: Set<string>,
			mode: string,
		) => {
			reconcileModes.push(mode);
			return {
				mode,
				createdOnDisk: [],
				updatedOnDisk: [],
				seededToCrdt: [],
				untracked: [],
				tombstonedDiskConflicts: [],
				pathBindingConflicts: [],
				skipped: 0,
			};
		},
		runIntegrityChecks: () => ({
			duplicateIds: 0,
			orphansCleaned: 0,
			duplicateActivePaths: 0,
		}),
	} as any;

	const reconciliation = new ReconciliationController({
		app: {
			vault: {
				getFiles: () => [],
				getMarkdownFiles: () => [],
				getAbstractFileByPath: () => null,
				adapter: { stat: async () => null },
			},
			workspace: { iterateAllLeaves: () => {} },
		} as any,
		getSettings: () => ({ deviceName: "Startup Race" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => sync,
		getDiskMirror: () => ({}) as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: (reason) => {
			reconciledReasons.push(reason);
			if (reconcileModes.at(-1) === "authoritative") authoritativeCompleteResolve();
		},
		getAwaitingFirstProviderSyncAfterStartup: () => awaitingFirstSync,
		setAwaitingFirstProviderSyncAfterStartup: (value) => { awaitingFirstSync = value; },
		saveDiskIndex: async () => {
			saveCalls++;
			if (saveCalls === 1) {
				firstSaveStartedResolve();
				await firstSaveRelease;
			}
		},
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	} as any);

	const connection = new ConnectionController({
		getVaultSync: () => sync,
		isReconciled: () => reconciliation.isReconciled,
		getAwaitingFirstProviderSyncAfterStartup: () => awaitingFirstSync,
		setAwaitingFirstProviderSyncAfterStartup: (value) => { awaitingFirstSync = value; },
		getLastReconciledGeneration: () => reconciliation.lastGeneration,
		setReconnectPending: () => reconciliation.markPending(),
		isReconcileInFlight: () => reconciliation.isReconcileInFlight,
		runReconnectReconciliation: (generation) => { void reconciliation.runReconnectReconciliation(generation); },
		refreshServerCapabilities: () => {},
		flushOpenWrites: () => {},
		updateOfflineStatus: () => {},
		refreshStatusBar: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		trace: () => {},
		registerCleanup: () => {},
	});

	const nativeSetTimeout = globalThis.setTimeout;
	let runScheduledFollowup: (() => void) | null = null;
	(globalThis as any).setTimeout = (handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
		if ((delay ?? 0) >= 9_000) {
			runScheduledFollowup = () => handler(...args);
			return { unref: () => {} };
		}
		return nativeSetTimeout(handler, delay, ...args);
	};

	try {
		connection.start();
		const startupRun = reconciliation.runReconciliation("conservative");
		await firstSaveStarted;
		providerSynced = true;
		connectionGeneration = 8;
		assert.ok(providerSyncHandler, "provider sync listener is installed for the full path");
		providerSyncHandler!(connectionGeneration);
		assert.equal(reconciliation.pending, true, "provider sync marks the active startup reconciliation pending");
		firstSaveReleaseResolve();
		await startupRun;
		assert.deepEqual(reconcileModes, ["conservative"], "the active startup pass remains conservative");
		assert.ok(runScheduledFollowup, "startup completion schedules the pending follow-up");

		// Advance the controller's elapsed-time fence to the point represented by
		// the captured cooldown callback, then execute that callback deterministically.
		(reconciliation as any).lastReconcileTime = Date.now() - 10_000;
		runScheduledFollowup!();
		await authoritativeComplete;

		assert.deepEqual(
			reconcileModes,
			["conservative", "authoritative"],
			"the pending startup edge is consumed by one authoritative follow-up",
		);
		assert.equal(reconciliation.pending, false, "the consumed startup marker is cleared");
		assert.deepEqual(
			reconciledReasons,
			["reconcile-conservative", "reconcile-authoritative"],
			"both completed passes reach normal reconciliation settlement",
		);
	} finally {
		globalThis.setTimeout = nativeSetTimeout;
		connection.stop();
		reconciliation.reset();
	}
}

console.log("PASS ConnectionController startup provider-sync race");
