import { readFileSync } from "node:fs";
import { VaultSync } from "../src/sync/vaultSync";
import {
	SOCKET_TICKET_RETRY_BASE_MS,
	SOCKET_TICKET_RETRY_MAX_MS,
	SocketTicketHttpError,
	socketTicketRetryDelayMs,
} from "../src/sync/socketTicket";
import { TICKET_TTL_MS } from "../server/src/routes/ticket";

let passed = 0;
let failed = 0;

function assert(condition: unknown, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${message}`);
	failed++;
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
	assert(
		actual === expected,
		`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
	);
}

interface TicketValue {
	value: string;
	expiresAt: number;
	localExpiresAt: number;
	ttlMs: number;
}

interface FakeProvider {
	url: string;
	shouldConnect?: boolean;
	wsconnected: boolean;
	wsconnecting: boolean;
	connect(): Promise<void>;
	disconnect(): void;
}

interface TicketHarness {
	provider: FakeProvider;
	_getSocketTicket: ((force?: boolean) => Promise<TicketValue | null>) | null;
	_socketTicketRefreshTimer: unknown | null;
	_socketTicketRefreshFailureCount: number;
	_socketTicketConnectRetryFailureCount: number;
	_socketTicketRefreshInFlight: boolean;
	_socketTicketRetryScheduled: boolean;
	_socketTicketRetryKind: "refresh" | "connect" | "auth" | null;
	_socketTicketRefreshPendingForOnline: boolean;
	_socketTicketOnlineHandler: (() => void) | null;
	_socketTicketConnectionWanted: boolean;
	_socketTicketConnectionIntentEpoch: number;
	_socketTicketConnectInFlight: Promise<void> | null;
	_socketTicketConnectInFlightIntentEpoch: number | null;
	_socketTicketRequestInFlight: Promise<TicketValue | null> | null;
	_socketTicketRequestInFlightForce: boolean;
	_socketTicketForcedRequestQueued: Promise<TicketValue | null> | null;
	_socketTicketRawDisconnect: (() => void) | null;
	_socketAuthRecoveryInFlight: boolean;
	_socketAuthRecoveryAttempted: boolean;
	_socketAuthRecoveryReconnectStarted: boolean;
	_socketAuthRecoveryMessage: unknown;
	_socketAuthRecoveryIntentEpoch: number | null;
	_socketAuthRecoveryRejectedSocket: unknown | null;
	_socketTicketConnectionCloseStatusPending: boolean;
	_socketTicketDisconnectRecoveryPending: boolean;
	_socketTicketReconnectAttemptedSinceSync: boolean;
	_destroyed: boolean;
	_fatalAuthError: boolean;
	_fatalAuthCode: string | null;
	_fatalAuthDetails: unknown;
	_providerSyncWaiters: Set<(value: boolean) => void>;
	_eventRing: Array<{ ts: string; msg: string }>;
	debug: boolean;
	trace?: undefined;
	refreshProviderTicketUrl(force?: boolean): Promise<boolean>;
	clearSocketTicketRefreshTimer(): void;
	scheduleSocketTicketRetry(kind: "refresh" | "connect" | "auth"): void;
	resumeDeferredSocketTicketRefresh(): void;
	recoverSocketTicketAfterDisconnect(): void;
	observeSocketTicketConnectionClose(closedSocket: unknown): void;
	handleSocketTicketDisconnectedStatus(): void;
	handleSocketTicketConnectionClose(closedSocket?: unknown): void;
	markSocketTicketSyncSucceeded(): void;
	requestSocketTicket(force?: boolean): Promise<TicketValue | null>;
	installSocketTicketProviderLifecycle(): void;
	markFatalAuth(msg: {
		code: "unauthorized";
		clientSchemaVersion: number | null;
		roomSchemaVersion: number | null;
		reason: string | null;
	}): void;
	tryRecoverSocketAuth(msg: {
		code: "unauthorized";
		clientSchemaVersion: number | null;
		roomSchemaVersion: number | null;
		reason: string | null;
	}): boolean;
}

function makeHarness(
	getTicket: ((force?: boolean) => Promise<TicketValue | null>) | null,
	providerOverrides: Partial<FakeProvider> = {},
): TicketHarness {
	const provider: FakeProvider = {
		url: "wss://sync.example/vault/test?_pk=device&ticket=old",
		shouldConnect: true,
		wsconnected: false,
		wsconnecting: false,
		async connect() {
			this.shouldConnect = true;
		},
		disconnect() {
			this.shouldConnect = false;
			this.wsconnected = false;
			this.wsconnecting = false;
		},
		...providerOverrides,
	};
	const sync = Object.create(VaultSync.prototype) as TicketHarness;
	Object.assign(sync, {
		provider,
		_getSocketTicket: getTicket,
		_socketTicketRefreshTimer: null,
		_socketTicketRefreshFailureCount: 0,
		_socketTicketConnectRetryFailureCount: 0,
		_socketTicketRefreshInFlight: false,
		_socketTicketRetryScheduled: false,
		_socketTicketRetryKind: null,
		_socketTicketRefreshPendingForOnline: false,
		_socketTicketOnlineHandler: null,
		_socketTicketConnectionWanted: true,
		_socketTicketConnectionIntentEpoch: 0,
		_socketTicketConnectInFlight: null,
		_socketTicketConnectInFlightIntentEpoch: null,
		_socketTicketRequestInFlight: null,
		_socketTicketRequestInFlightForce: false,
		_socketTicketForcedRequestQueued: null,
		_socketTicketRawDisconnect: null,
		_socketAuthRecoveryInFlight: false,
		_socketAuthRecoveryAttempted: false,
		_socketAuthRecoveryReconnectStarted: false,
		_socketAuthRecoveryMessage: null,
		_socketAuthRecoveryIntentEpoch: null,
		_socketAuthRecoveryRejectedSocket: null,
		_socketTicketConnectionCloseStatusPending: false,
		_socketTicketDisconnectRecoveryPending: false,
		_socketTicketReconnectAttemptedSinceSync: false,
		_destroyed: false,
		_fatalAuthError: false,
		_fatalAuthCode: null,
		_fatalAuthDetails: null,
		_providerSyncWaiters: new Set(),
		_eventRing: [],
		debug: false,
		trace: undefined,
	});
	return sync;
}

interface CapturedTimer {
	callback: () => void;
	delay: number;
	cleared: boolean;
	fired: boolean;
}

function installFakeTimers(): {
	timers: CapturedTimer[];
	fire(timer: CapturedTimer): void;
	restore(): void;
} {
	const timers: CapturedTimer[] = [];
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((callback: () => void, delay = 0) => {
		const timer: CapturedTimer = { callback, delay: Number(delay), cleared: false, fired: false };
		timers.push(timer);
		return timer as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = ((handle: unknown) => {
		const timer = handle as CapturedTimer;
		if (timer && typeof timer === "object") timer.cleared = true;
	}) as typeof clearTimeout;
	return {
		timers,
		fire(timer) {
			if (timer.cleared || timer.fired) throw new Error("cannot fire inactive timer");
			timer.fired = true;
			timer.callback();
		},
		restore() {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		},
	};
}

function activeTimers(timers: CapturedTimer[]): CapturedTimer[] {
	return timers.filter((timer) => !timer.cleared && !timer.fired);
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function drainAsync(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function installOnlineState(initial: boolean): { set(value: boolean): void; restore(): void } {
	let online = initial;
	const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	const existing = typeof navigator === "undefined" ? null : navigator;
	const target = existing ?? {};
	const onLineDescriptor = Object.getOwnPropertyDescriptor(target, "onLine");
	if (!existing) {
		Object.defineProperty(globalThis, "navigator", { configurable: true, value: target });
	}
	Object.defineProperty(target, "onLine", {
		configurable: true,
		get: () => online,
	});
	return {
		set(value) {
			online = value;
		},
		restore() {
			if (onLineDescriptor) Object.defineProperty(target, "onLine", onLineDescriptor);
			else delete (target as { onLine?: boolean }).onLine;
			if (!existing) {
				if (globalDescriptor) Object.defineProperty(globalThis, "navigator", globalDescriptor);
				else delete (globalThis as { navigator?: Navigator }).navigator;
			}
		},
	};
}

const AUTH_MSG = {
	code: "unauthorized" as const,
	clientSchemaVersion: null,
	roomSchemaVersion: null,
	reason: "test",
};

console.log("\n--- socket ticket retry delay: bounded exponential equal jitter ---");
{
	assertEqual(socketTicketRetryDelayMs(1, 0), 30_000, "first retry never fires before 30 seconds");
	assertEqual(socketTicketRetryDelayMs(1, 1), 60_000, "first retry jitter ceiling is 60 seconds");
	assertEqual(socketTicketRetryDelayMs(2, 0), 60_000, "second retry lower bound doubles");
	assertEqual(socketTicketRetryDelayMs(2, 1), 120_000, "second retry ceiling doubles");
	assertEqual(
		socketTicketRetryDelayMs(100, 0),
		SOCKET_TICKET_RETRY_MAX_MS / 2,
		"capped retries retain a 2.5 minute minimum",
	);
	assertEqual(
		socketTicketRetryDelayMs(100, 1),
		SOCKET_TICKET_RETRY_MAX_MS,
		"retry delay never exceeds the five-minute ticket lifetime cap",
	);
	assert(
		socketTicketRetryDelayMs(1, 0.2) !== socketTicketRetryDelayMs(1, 0.8),
		"jitter de-correlates devices in the same failure window",
	);
	assertEqual(SOCKET_TICKET_RETRY_BASE_MS, 30_000, "base delay preserves the previous retry floor");
}

console.log("\n--- socket ticket refresh: success preserves the normal five-minute cadence ---");
{
	const clock = installFakeTimers();
	const originalNow = Date.now;
	Date.now = () => 1_000_000;
	try {
		const sync = makeHarness(async () => ({
			value: "fresh",
			expiresAt: 1_000_000 + TICKET_TTL_MS,
			localExpiresAt: 1_000_000 + TICKET_TTL_MS,
			ttlMs: TICKET_TTL_MS,
		}));
		sync._socketTicketRefreshFailureCount = 4;
		assert(await sync.refreshProviderTicketUrl(true), "successful proactive refresh returns true");
		assertEqual(sync._socketTicketRefreshFailureCount, 0, "successful ticket fetch resets backoff");
		assertEqual(
			activeTimers(clock.timers)[0]?.delay,
			TICKET_TTL_MS - 30_000,
			"five-minute ticket still refreshes 30 seconds before expiry",
		);
		assert(new URL(sync.provider.url).searchParams.get("ticket") === "fresh", "provider URL receives fresh ticket");
	} finally {
		Date.now = originalNow;
		clock.restore();
	}
}

console.log("\n--- socket ticket refresh: failures back off, dedupe, and preserve connect priority ---");
{
	const clock = installFakeTimers();
	const originalRandom = Math.random;
	Math.random = () => 0;
	let calls = 0;
	try {
		const sync = makeHarness(async () => {
			calls++;
			throw new Error("ticket endpoint unavailable");
		});
		assert(!(await sync.refreshProviderTicketUrl(true)), "failed refresh returns false");
		assertEqual(calls, 1, "first failure performs one ticket request");
		assertEqual(activeTimers(clock.timers)[0]?.delay, 30_000, "first failure schedules bounded retry");
		await sync.refreshProviderTicketUrl(true);
		assertEqual(calls, 1, "retry-scheduled guard blocks duplicate immediate request");
		const existingTimer = activeTimers(clock.timers)[0];
		sync.scheduleSocketTicketRetry("connect");
		assertEqual(activeTimers(clock.timers).length, 1, "connect recovery reuses existing retry timer");
		assert(activeTimers(clock.timers)[0] === existingTimer, "connect priority does not reset current backoff");
		assertEqual(sync._socketTicketRetryKind, "connect", "connect recovery dominates URL-only refresh");
	} finally {
		Math.random = originalRandom;
		clock.restore();
	}
}

console.log("\n--- socket ticket requests: connect and HTTP work are single-flight ---");
{
	const clock = installFakeTimers();
	const ticket = deferred<TicketValue | null>();
	let ticketCalls = 0;
	let rawConnectCalls = 0;
	const sync = makeHarness(async () => {
		ticketCalls++;
		return ticket.promise;
	}, {
		async connect() {
			rawConnectCalls++;
			const attemptEpoch = sync._socketTicketConnectionIntentEpoch;
			await sync.requestSocketTicket();
			if (attemptEpoch !== sync._socketTicketConnectionIntentEpoch) {
				throw new Error("socket ticket connection cancelled");
			}
		},
	});
	try {
		sync._socketTicketConnectionWanted = false;
		sync.installSocketTicketProviderLifecycle();
		const first = sync.provider.connect();
		const firstEpoch = sync._socketTicketConnectionIntentEpoch;
		const second = sync.provider.connect();
		const concurrentTicket = sync.requestSocketTicket(false);
		assert(first === second, "overlapping provider.connect calls share one promise");
		assertEqual(
			sync._socketTicketConnectionIntentEpoch,
			firstEpoch,
			"idempotent duplicate connect does not invalidate the active params epoch",
		);
		assertEqual(rawConnectCalls, 1, "only one raw async params/connect call starts");
		assertEqual(ticketCalls, 1, "connect and concurrent refresh share one ticket HTTP request");
		ticket.resolve({
			value: "single-flight",
			expiresAt: Date.now() + TICKET_TTL_MS,
			localExpiresAt: Date.now() + TICKET_TTL_MS,
			ttlMs: TICKET_TTL_MS,
		});
		await Promise.all([first, second, concurrentTicket]);
		assertEqual(sync._socketTicketConnectInFlight, null, "connect single-flight clears after completion");
		assertEqual(sync._socketTicketRequestInFlight, null, "ticket HTTP single-flight clears after completion");
	} finally {
		clock.restore();
	}
}

console.log("\n--- socket ticket connect intent: reconnect detaches a revoked stale attempt ---");
{
	const clock = installFakeTimers();
	const ticket = deferred<TicketValue | null>();
	let rawConnectCalls = 0;
	const sync = makeHarness(async () => ticket.promise, {
		async connect() {
			rawConnectCalls++;
			const attemptEpoch = sync._socketTicketConnectionIntentEpoch;
			await sync.requestSocketTicket();
			if (attemptEpoch !== sync._socketTicketConnectionIntentEpoch) {
				throw new Error("socket ticket connection cancelled");
			}
			this.shouldConnect = true;
		},
	});
	try {
		sync._socketTicketConnectionWanted = false;
		sync.installSocketTicketProviderLifecycle();
		const stale = sync.provider.connect();
		sync.provider.disconnect();
		const fresh = sync.provider.connect();
		assert(stale !== fresh, "new intent starts a distinct raw attempt while revoked work settles");
		assertEqual(rawConnectCalls, 2, "manual reconnect is not delayed behind stale async params");
		ticket.resolve({
			value: "shared-fresh",
			expiresAt: Date.now() + TICKET_TTL_MS,
			localExpiresAt: Date.now() + TICKET_TTL_MS,
			ttlMs: TICKET_TTL_MS,
		});
		await stale.catch(() => undefined);
		await fresh;
		assert(sync._socketTicketConnectionWanted, "fresh intent survives stale attempt rejection");
		assertEqual(sync._socketTicketRetryScheduled, false, "stale rejection cannot schedule a retry for fresh intent");
	} finally {
		clock.restore();
	}
}

console.log("\n--- socket ticket connect intent: auth epoch fence detaches active work ---");
{
	const ticket = deferred<TicketValue | null>();
	let rawConnectCalls = 0;
	const sync = makeHarness(async () => ticket.promise, {
		async connect() {
			rawConnectCalls++;
			const attemptEpoch = sync._socketTicketConnectionIntentEpoch;
			await sync.requestSocketTicket();
			if (attemptEpoch !== sync._socketTicketConnectionIntentEpoch) {
				throw new Error("socket ticket connection cancelled");
			}
		},
	});
	sync._socketTicketConnectionWanted = false;
	sync.installSocketTicketProviderLifecycle();
	const stale = sync.provider.connect();
	// Auth recovery invalidates params while preserving the app's wanted=true
	// connection intent. The in-flight attempt epoch must still distinguish it.
	sync._socketTicketConnectionIntentEpoch++;
	const fresh = sync.provider.connect();
	assert(stale !== fresh, "auth epoch invalidation detaches stale connect despite wanted=true");
	assertEqual(rawConnectCalls, 2, "fresh auth intent starts a new raw params attempt immediately");
	ticket.resolve({
		value: "auth-shared-fresh",
		expiresAt: Date.now() + TICKET_TTL_MS,
		localExpiresAt: Date.now() + TICKET_TTL_MS,
		ttlMs: TICKET_TTL_MS,
	});
	await stale.catch(() => undefined);
	await fresh;
	assertEqual(sync._socketTicketRetryScheduled, false, "auth-fenced stale rejection has no retry side effect");
}

console.log("\n--- socket ticket requests: forced refresh serializes behind non-forced work ---");
{
	const firstTicket = deferred<TicketValue | null>();
	const forcedTicket = deferred<TicketValue | null>();
	const forces: boolean[] = [];
	const sync = makeHarness(async (force = false) => {
		forces.push(force);
		return forces.length === 1 ? firstTicket.promise : forcedTicket.promise;
	});
	const nonForced = sync.requestSocketTicket(false);
	const forcedA = sync.requestSocketTicket(true);
	const forcedB = sync.requestSocketTicket(true);
	assert(forcedA === forcedB, "concurrent forced callers share one queued request");
	assertEqual(forces.join(","), "false", "forced request waits for active non-forced request");
	firstTicket.resolve({
		value: "cached-candidate",
		expiresAt: Date.now() + TICKET_TTL_MS,
		localExpiresAt: Date.now() + TICKET_TTL_MS,
		ttlMs: TICKET_TTL_MS,
	});
	await nonForced;
	await drainAsync();
	assertEqual(forces.join(","), "false,true", "queued work performs exactly one real forced request");
	forcedTicket.resolve({
		value: "forced-fresh",
		expiresAt: Date.now() + TICKET_TTL_MS,
		localExpiresAt: Date.now() + TICKET_TTL_MS,
		ttlMs: TICKET_TTL_MS,
	});
	assertEqual((await forcedA)?.value, "forced-fresh", "auth force never inherits non-forced ticket result");
	await forcedB;
}

console.log("\n--- socket ticket requests: terminal state cancels queued forced work ---");
{
	const firstTicket = deferred<TicketValue | null>();
	let calls = 0;
	const sync = makeHarness(async () => {
		calls++;
		return firstTicket.promise;
	});
	const nonForced = sync.requestSocketTicket(false);
	const forced = sync.requestSocketTicket(true);
	sync._destroyed = true;
	firstTicket.resolve({
		value: "too-late",
		expiresAt: Date.now() + TICKET_TTL_MS,
		localExpiresAt: Date.now() + TICKET_TTL_MS,
		ttlMs: TICKET_TTL_MS,
	});
	await nonForced;
	assertEqual(await forced, null, "destroy turns queued forced request into a no-op");
	assertEqual(calls, 1, "destroy prevents queued force from issuing another HTTP request");
}

console.log("\n--- socket ticket initial connect: failure uses bounded connect retry ---");
{
	const clock = installFakeTimers();
	const originalRandom = Math.random;
	Math.random = () => 0;
	let rawConnectCalls = 0;
	let shouldFail = true;
	const sync = makeHarness(async () => null, {
		async connect() {
			rawConnectCalls++;
			if (shouldFail) throw new Error("initial params failed");
		},
	});
	try {
		sync._socketTicketConnectionWanted = false;
		sync.installSocketTicketProviderLifecycle();
		await sync.provider.connect().catch(() => undefined);
		assertEqual(rawConnectCalls, 1, "initial connection is attempted once");
		assert(sync._socketTicketConnectionWanted, "failed params retain app-owned connection intent");
		assertEqual(sync._socketTicketRetryKind, "connect", "initial params failure schedules connect recovery");
		const retry = activeTimers(clock.timers)[0];
		assertEqual(retry?.delay, 30_000, "initial failure uses bounded retry policy");
		shouldFail = false;
		clock.fire(retry);
		await drainAsync();
		assertEqual(rawConnectCalls, 2, "retry timer resumes the failed initial connection");
		assertEqual(sync._socketTicketConnectInFlight, null, "successful retry releases connect single-flight");
	} finally {
		Math.random = originalRandom;
		clock.restore();
	}
}

console.log("\n--- socket ticket retry: intentional disconnect cancels pending work ---");
{
	const clock = installFakeTimers();
	const originalRandom = Math.random;
	Math.random = () => 0;
	let rawConnectCalls = 0;
	const sync = makeHarness(async () => null, {
		async connect() {
			rawConnectCalls++;
			throw new Error("temporary failure");
		},
	});
	try {
		sync._socketTicketConnectionWanted = false;
		sync.installSocketTicketProviderLifecycle();
		await sync.provider.connect().catch(() => undefined);
		const retry = activeTimers(clock.timers)[0];
		sync.provider.disconnect();
		assert(retry.cleared, "intentional disconnect clears pending retry timer");
		// Even a stale callback that was already queued observes revoked app intent.
		retry.callback();
		await drainAsync();
		assertEqual(rawConnectCalls, 1, "stale retry callback performs no connect after disconnect");
	} finally {
		Math.random = originalRandom;
		clock.restore();
	}
}

console.log("\n--- socket ticket lifecycle: legacy no-ticket provider remains connected ---");
{
	let rawDisconnectCalls = 0;
	const sync = makeHarness(null, {
		async connect() {
			this.wsconnected = true;
			this.shouldConnect = true;
		},
		disconnect() {
			rawDisconnectCalls++;
			this.wsconnected = false;
			this.shouldConnect = false;
		},
	});
	sync._socketTicketConnectionWanted = false;
	sync.installSocketTicketProviderLifecycle();
	await sync.provider.connect();
	assert(sync.provider.wsconnected, "optional ticket callback does not gate legacy provider connect");
	assertEqual(rawDisconnectCalls, 0, "legacy successful connect is not torn down by ticket guard");
}

console.log("\n--- socket ticket offline pause: no request and one online resume ---");
{
	const clock = installFakeTimers();
	const network = installOnlineState(false);
	let ticketCalls = 0;
	try {
		const sync = makeHarness(async () => {
			ticketCalls++;
			return {
				value: "online-ticket",
				expiresAt: Date.now() + TICKET_TTL_MS,
				localExpiresAt: Date.now() + TICKET_TTL_MS,
				ttlMs: TICKET_TTL_MS,
			};
		});
		sync._socketTicketOnlineHandler = () => sync.resumeDeferredSocketTicketRefresh();
		assert(!(await sync.refreshProviderTicketUrl(true)), "offline refresh is deferred");
		assertEqual(ticketCalls, 0, "known-offline state performs zero ticket requests");
		assert(sync._socketTicketRefreshPendingForOnline, "offline refresh records explicit resume work");
		network.set(true);
		sync._socketTicketOnlineHandler();
		sync._socketTicketOnlineHandler();
		await drainAsync();
		assertEqual(ticketCalls, 1, "online event resumes deferred refresh exactly once");
		assert(!sync._socketTicketRefreshPendingForOnline, "online resume consumes pending marker");
	} finally {
		network.restore();
		clock.restore();
	}
}

console.log("\n--- socket close recovery: first retry is immediate, pre-sync flaps back off ---");
{
	const clock = installFakeTimers();
	const originalRandom = Math.random;
	Math.random = () => 0;
	let ticketCalls = 0;
	let rawDisconnectCalls = 0;
	let connectCalls = 0;
	try {
		const sync = makeHarness(async () => {
			ticketCalls++;
			return {
				value: `close-ticket-${ticketCalls}`,
				expiresAt: Date.now() + TICKET_TTL_MS,
				localExpiresAt: Date.now() + TICKET_TTL_MS,
				ttlMs: TICKET_TTL_MS,
			};
		}, {
			async connect() {
				connectCalls++;
				this.shouldConnect = true;
			},
			disconnect() {
				rawDisconnectCalls++;
				this.shouldConnect = false;
			},
		});
		sync._socketTicketRawDisconnect = sync.provider.disconnect.bind(sync.provider);

		// This models connection-close with wsconnected=false: y-partyserver emits
		// no disconnected status in that branch and would otherwise retry natively.
		sync.handleSocketTicketConnectionClose();
		await drainAsync();
		assertEqual(rawDisconnectCalls, 1, "handshake close disables the vendor reconnect loop");
		assertEqual(ticketCalls, 1, "first close force-refreshes the socket ticket once");
		assertEqual(connectCalls, 1, "one immediate reconnect is allowed after the last sync proof");

		sync.handleSocketTicketConnectionClose();
		assertEqual(rawDisconnectCalls, 2, "second pre-sync close pauses vendor reconnect again");
		assertEqual(ticketCalls, 1, "pre-sync flap does not issue another immediate ticket request");
		const firstBackoff = activeTimers(clock.timers)[0];
		assertEqual(firstBackoff?.delay, 30_000, "second pre-sync close enters 30-60s app backoff");
		assertEqual(sync._socketTicketConnectRetryFailureCount, 1, "connect flap counter advances independently");

		clock.fire(firstBackoff);
		await drainAsync();
		assertEqual(connectCalls, 2, "bounded timer performs the next reconnect attempt");
		sync.handleSocketTicketConnectionClose();
		const secondBackoff = activeTimers(clock.timers)[0];
		assertEqual(secondBackoff?.delay, 60_000, "another pre-sync close doubles the jitter window");
		assertEqual(sync._socketTicketConnectRetryFailureCount, 2, "socket open alone does not reset flap backoff");
	} finally {
		Math.random = originalRandom;
		clock.restore();
	}
}

console.log("\n--- socket ticket disconnect recovery: ticket failure stays paused and bounded ---");
{
	const clock = installFakeTimers();
	const originalRandom = Math.random;
	Math.random = () => 0;
	let rawDisconnectCalls = 0;
	let connectCalls = 0;
	try {
		const sync = makeHarness(async () => {
			throw new Error("ticket endpoint down");
		}, {
			async connect() {
				connectCalls++;
			},
			disconnect() {
				rawDisconnectCalls++;
				this.shouldConnect = false;
			},
		});
		sync._socketTicketRawDisconnect = sync.provider.disconnect.bind(sync.provider);
		sync.recoverSocketTicketAfterDisconnect();
		await drainAsync();
		assertEqual(rawDisconnectCalls, 1, "disconnected recovery pauses vendor reconnect loop immediately");
		assertEqual(connectCalls, 0, "failed ticket refresh does not reconnect with stale URL");
		assertEqual(sync._socketTicketRetryKind, "connect", "disconnected failure schedules connect recovery");
		assertEqual(activeTimers(clock.timers)[0]?.delay, 30_000, "paused reconnect uses bounded ticket retry");
	} finally {
		Math.random = originalRandom;
		clock.restore();
	}
}

console.log("\n--- socket close recovery: only sync proof re-arms immediate recovery ---");
{
	const clock = installFakeTimers();
	let ticketCalls = 0;
	let connectCalls = 0;
	const sync = makeHarness(async () => {
		ticketCalls++;
		return {
			value: "post-sync-ticket",
			expiresAt: Date.now() + TICKET_TTL_MS,
			localExpiresAt: Date.now() + TICKET_TTL_MS,
			ttlMs: TICKET_TTL_MS,
		};
	}, {
		async connect() {
			connectCalls++;
			this.shouldConnect = true;
		},
		disconnect() {
			this.shouldConnect = false;
		},
	});
	try {
		sync._socketTicketRawDisconnect = sync.provider.disconnect.bind(sync.provider);
		sync._socketTicketReconnectAttemptedSinceSync = true;
		sync._socketTicketConnectRetryFailureCount = 4;
		sync.markSocketTicketSyncSucceeded();
		assert(!sync._socketTicketReconnectAttemptedSinceSync, "sync proof re-arms one immediate reconnect");
		assertEqual(sync._socketTicketConnectRetryFailureCount, 0, "sync proof resets connection-flap backoff");
		sync.handleSocketTicketConnectionClose();
		await drainAsync();
		assertEqual(ticketCalls, 1, "first close after sync receives one immediate ticket refresh");
		assertEqual(connectCalls, 1, "first close after sync receives one immediate reconnect");
	} finally {
		clock.restore();
	}
}

console.log("\n--- socket ticket terminal races: stale fetch cannot revive URL or timer ---");
for (const terminal of ["destroy", "fatal"] as const) {
	const clock = installFakeTimers();
	const ticket = deferred<TicketValue | null>();
	try {
		const sync = makeHarness(async () => ticket.promise);
		const originalUrl = sync.provider.url;
		const refresh = sync.refreshProviderTicketUrl(true);
		await drainAsync();
		if (terminal === "destroy") {
			sync._destroyed = true;
			sync._socketTicketConnectionWanted = false;
			sync.clearSocketTicketRefreshTimer();
		} else {
			sync.markFatalAuth(AUTH_MSG);
		}
		ticket.resolve({
			value: `${terminal}-stale`,
			expiresAt: Date.now() + TICKET_TTL_MS,
			localExpiresAt: Date.now() + TICKET_TTL_MS,
			ttlMs: TICKET_TTL_MS,
		});
		assert(!(await refresh), `${terminal}: stale in-flight fetch is rejected`);
		assertEqual(sync.provider.url, originalUrl, `${terminal}: stale ticket does not patch provider URL`);
		assertEqual(activeTimers(clock.timers).length, 0, `${terminal}: stale ticket does not resurrect timer`);
	} finally {
		clock.restore();
	}
}

console.log("\n--- socket auth recovery: fresh pre-sync close enters app backoff ---");
{
	const clock = installFakeTimers();
	const originalRandom = Math.random;
	Math.random = () => 0;
	let rawDisconnectCalls = 0;
	try {
		const sync = makeHarness(async () => {
			throw new Error("must not fetch during pre-sync close classification");
		}, {
			disconnect() {
				rawDisconnectCalls++;
				this.shouldConnect = false;
			},
		});
		sync._socketTicketRawDisconnect = sync.provider.disconnect.bind(sync.provider);
		sync._socketAuthRecoveryInFlight = true;
		sync._socketAuthRecoveryReconnectStarted = false;
		sync._socketTicketReconnectAttemptedSinceSync = true;
		const rejectedSocket = { id: "rejected-old" };
		const freshSocket = { id: "fresh-handshake" };
		sync._socketAuthRecoveryRejectedSocket = rejectedSocket;
		// Model the race where fresh connect() has already restored shouldConnect
		// before the rejected old socket emits its close + disconnected pair.
		sync.provider.shouldConnect = true;
		sync.observeSocketTicketConnectionClose(rejectedSocket);
		assertEqual(rawDisconnectCalls, 0, "closing the rejected old auth socket is ignored");
		assertEqual(activeTimers(clock.timers).length, 0, "old auth close creates no competing retry");
		sync.handleSocketTicketDisconnectedStatus();
		assertEqual(rawDisconnectCalls, 0, "status fallback for the same old close is deduplicated");
		assertEqual(activeTimers(clock.timers).length, 0, "deduped old status creates no retry");

		sync.provider.shouldConnect = true;
		sync.observeSocketTicketConnectionClose(freshSocket);
		assertEqual(rawDisconnectCalls, 1, "fresh auth handshake close pauses vendor reconnect before connected status");
		assertEqual(sync._socketTicketRetryKind, "connect", "fresh pre-sync auth close uses connect backoff");
		assertEqual(activeTimers(clock.timers)[0]?.delay, 30_000, "fresh pre-sync auth close cannot tight-loop");
		await drainAsync();
	} finally {
		Math.random = originalRandom;
		clock.restore();
	}
}

console.log("\n--- socket auth recovery: destroy cancels recovery and recovery stays one-shot ---");
{
	const clock = installFakeTimers();
	const ticket = deferred<TicketValue | null>();
	let connectCalls = 0;
	try {
		const sync = makeHarness(async () => ticket.promise, {
			async connect() {
				connectCalls++;
			},
		});
		assert(sync.tryRecoverSocketAuth(AUTH_MSG), "first unauthorized starts one recovery");
		assert(!sync.tryRecoverSocketAuth(AUTH_MSG), "second unauthorized cannot start concurrent recovery");
		sync._destroyed = true;
		ticket.resolve({
			value: "too-late",
			expiresAt: Date.now() + TICKET_TTL_MS,
			localExpiresAt: Date.now() + TICKET_TTL_MS,
			ttlMs: TICKET_TTL_MS,
		});
		await drainAsync();
		assertEqual(connectCalls, 0, "destroyed auth recovery never reconnects");
		assert(!sync._fatalAuthError, "destroyed auth recovery does not mark a torn-down instance fatal");
		assertEqual(activeTimers(clock.timers).length, 0, "destroyed auth recovery leaves no timer");
	} finally {
		clock.restore();
	}
}

console.log("\n--- socket auth recovery: offline resumes with a forced ticket exactly once ---");
{
	const clock = installFakeTimers();
	const network = installOnlineState(false);
	const forces: boolean[] = [];
	let connectCalls = 0;
	try {
		const sync = makeHarness(async (force = false) => {
			forces.push(force);
			return {
				value: "auth-fresh",
				expiresAt: Date.now() + TICKET_TTL_MS,
				localExpiresAt: Date.now() + TICKET_TTL_MS,
				ttlMs: TICKET_TTL_MS,
			};
		}, {
			async connect() {
				connectCalls++;
			},
		});
		sync._socketTicketOnlineHandler = () => sync.resumeDeferredSocketTicketRefresh();
		sync._socketTicketRawDisconnect = () => undefined;
		assert(sync.tryRecoverSocketAuth(AUTH_MSG), "offline unauthorized enters recovery state");
		assertEqual(forces.length, 0, "offline auth recovery performs zero HTTP requests");
		assertEqual(sync._socketTicketRetryKind, "auth", "offline state preserves forced auth action");
		network.set(true);
		sync._socketTicketOnlineHandler();
		sync._socketTicketOnlineHandler();
		await drainAsync();
		assertEqual(forces.join(","), "true", "online auth resume bypasses rejected ticket cache exactly once");
		assertEqual(connectCalls, 1, "fresh auth ticket resumes provider once");
	} finally {
		network.restore();
		clock.restore();
	}
}

console.log("\n--- socket auth recovery: manual disconnect fences a late ticket ---");
{
	const clock = installFakeTimers();
	const ticket = deferred<TicketValue | null>();
	let rawConnectCalls = 0;
	const sync = makeHarness(async () => ticket.promise, {
		async connect() {
			rawConnectCalls++;
		},
	});
	try {
		sync.installSocketTicketProviderLifecycle();
		const originalUrl = sync.provider.url;
		assert(sync.tryRecoverSocketAuth(AUTH_MSG), "auth recovery starts before manual pause");
		sync.provider.disconnect();
		assert(sync._socketAuthRecoveryAttempted, "explicit disconnect preserves auth recovery one-shot latch");
		ticket.resolve({
			value: "late-after-pause",
			expiresAt: Date.now() + TICKET_TTL_MS,
			localExpiresAt: Date.now() + TICKET_TTL_MS,
			ttlMs: TICKET_TTL_MS,
		});
		await drainAsync();
		assertEqual(rawConnectCalls, 0, "manual disconnect prevents late auth reconnect");
		assertEqual(sync.provider.url, originalUrl, "manual disconnect prevents late ticket URL patch");
		assertEqual(activeTimers(clock.timers).length, 0, "manual disconnect leaves no auth retry timer");
	} finally {
		clock.restore();
	}
}

console.log("\n--- socket auth recovery: transient failure stays bounded and duplicate-safe ---");
{
	const clock = installFakeTimers();
	const originalRandom = Math.random;
	Math.random = () => 0;
	try {
		const sync = makeHarness(async () => {
			throw new Error("temporary 503");
		});
		sync._socketTicketRawDisconnect = () => undefined;
		assert(sync.tryRecoverSocketAuth(AUTH_MSG), "transient auth refresh starts recovery");
		await drainAsync();
		assert(!sync._fatalAuthError, "transient auth refresh failure is not fatal");
		assert(sync._socketAuthRecoveryInFlight, "recovery remains active while bounded retry waits");
		assertEqual(sync._socketTicketRetryKind, "auth", "retry retains forced-auth semantics");
		assertEqual(activeTimers(clock.timers)[0]?.delay, 30_000, "transient auth failure uses bounded backoff");
		assert(!sync.tryRecoverSocketAuth(AUTH_MSG), "duplicate unauthorized cannot fan out another recovery");
	} finally {
		Math.random = originalRandom;
		clock.restore();
	}
}

console.log("\n--- socket ticket HTTP auth errors: initial, proactive, and recovery paths stop ---");
{
	const proactiveClock = installFakeTimers();
	try {
		const sync = makeHarness(async () => {
			throw new SocketTicketHttpError(401);
		});
		await sync.refreshProviderTicketUrl(true);
		assert(sync._fatalAuthError, "proactive ticket 401 marks auth fatal");
		assertEqual(activeTimers(proactiveClock.timers).length, 0, "proactive ticket 401 schedules no retry");
	} finally {
		proactiveClock.restore();
	}

	const initialClock = installFakeTimers();
	try {
		const sync = makeHarness(async () => null, {
			async connect() {
				throw new SocketTicketHttpError(403);
			},
		});
		sync._socketTicketConnectionWanted = false;
		sync.installSocketTicketProviderLifecycle();
		await sync.provider.connect().catch(() => undefined);
		assert(sync._fatalAuthError, "initial ticket 403 marks auth fatal");
		assertEqual(activeTimers(initialClock.timers).length, 0, "initial ticket 403 schedules no retry");
	} finally {
		initialClock.restore();
	}

	const recoveryClock = installFakeTimers();
	try {
		const sync = makeHarness(async () => {
			throw new SocketTicketHttpError(401);
		});
		sync._socketTicketRawDisconnect = () => undefined;
		assert(sync.tryRecoverSocketAuth(AUTH_MSG), "auth recovery attempts forced ticket before terminal classification");
		await drainAsync();
		assert(sync._fatalAuthError, "auth recovery ticket 401 marks auth fatal");
		assertEqual(activeTimers(recoveryClock.timers).length, 0, "auth recovery ticket 401 schedules no retry");
	} finally {
		recoveryClock.restore();
	}
}

console.log("\n--- socket ticket lifecycle: source ordering guards ---");
{
	const source = readFileSync(new URL("../src/sync/vaultSync.ts", import.meta.url), "utf8");
	const connectedBlock = source.slice(
		source.indexOf('if (event.status === "connected")'),
		source.indexOf('} else if (', source.indexOf('if (event.status === "connected")')),
	);
	assert(
		!connectedBlock.includes("_socketAuthRecoveryAttempted = false"),
		"socket open alone cannot re-arm auth recovery",
	);
	const syncProof = source.indexOf('this.provider.on("sync", (synced: boolean) =>');
	assert(
		syncProof >= 0 && source.slice(syncProof, syncProof + 300).includes("markSocketTicketSyncSucceeded()"),
		"successful Yjs sync invokes the sole reconnect-success reset",
	);
	const syncReset = source.indexOf("private markSocketTicketSyncSucceeded(): void");
	const syncResetBody = source.slice(syncReset, syncReset + 900);
	assert(
		syncResetBody.includes("_socketAuthRecoveryAttempted = false")
			&& syncResetBody.includes("_socketTicketReconnectAttemptedSinceSync = false")
			&& syncResetBody.includes("_socketTicketConnectRetryFailureCount = 0"),
		"sync proof resets auth recovery and connection-flap backoff together",
	);
	const disconnectWrapper = source.indexOf("provider.disconnect = (): void =>");
	const disconnectWrapperBody = source.slice(disconnectWrapper, disconnectWrapper + 700);
	assert(
		!disconnectWrapperBody.includes("_socketTicketReconnectAttemptedSinceSync = false")
			&& !disconnectWrapperBody.includes("_socketTicketConnectRetryFailureCount = 0"),
		"plain disconnect cannot re-arm pre-sync reconnect or reset its backoff",
	);
	const paramsStart = source.indexOf("params: async () =>");
	const paramsBody = source.slice(paramsStart, paramsStart + 2_000);
	assert(
		paramsBody.includes("paramsIntentEpoch")
			&& paramsBody.includes("this._socketTicketConnectionIntentEpoch !== paramsIntentEpoch"),
		"async provider params fences stale connection intents after ticket await",
	);
	assert(
		source.includes('.on("connection-close",')
			&& source.includes("this.observeSocketTicketConnectionClose("),
		"handshake closes are guarded even when no disconnected status is emitted",
	);
	const destroyStart = source.indexOf("async destroy(): Promise<void>");
	const destroyBody = source.slice(destroyStart, destroyStart + 900);
	assert(
		destroyBody.indexOf("this._destroyed = true") < destroyBody.indexOf("await this.flushReceiptPersistence()"),
		"destroy marks terminal state before its first await",
	);
	assert(
		destroyBody.indexOf("this.provider.disconnect()") < destroyBody.indexOf("await this.flushReceiptPersistence()"),
		"destroy revokes connection intent before its first await",
	);
	const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
	const schemaPreflight = mainSource.indexOf("// Schema version check — refuse to run");
	const schemaPreflightBody = mainSource.slice(schemaPreflight, schemaPreflight + 700);
	assert(
		schemaPreflight >= 0
			&& schemaPreflightBody.indexOf("vaultSync.provider.disconnect()")
				< schemaPreflightBody.indexOf("return;"),
		"local newer-schema preflight stops ticket retries before returning",
	);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) process.exit(1);
