import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { SCHEMA_VERSION } from "../sync/schema";
import { HEADLESS_CLIENT_KIND } from "./doc";

const TICKET_REFRESH_BUFFER_MS = 30_000;
const MAX_REASONABLE_TICKET_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export interface HeadlessSyncClientOptions {
	host: string;
	token: string;
	vaultId: string;
	deviceName: string;
	connectTimeoutMs?: number;
	maxBackoffTimeMs?: number;
	webSocketPolyfill?: typeof globalThis.WebSocket;
	fetchImpl?: typeof fetch;
	log?: (event: HeadlessProviderLogEvent) => void;
}

export type HeadlessProviderLogEvent =
	| { kind: "provider-status"; status: string }
	| { kind: "provider-ticket-auth-unsupported" }
	| { kind: "provider-ticket-refresh"; expiresAt: number; ttlMs: number }
	| { kind: "provider-ticket-refresh-failed"; error: string }
	| { kind: "provider-server-error"; code: string; details: Record<string, unknown> };
type HeadlessServerErrorEvent = Extract<HeadlessProviderLogEvent, { kind: "provider-server-error" }>;

interface CachedSocketTicket {
	value: string;
	expiresAt: number;
	localExpiresAt: number;
	ttlMs: number;
}

class SocketTicketHttpError extends Error {
	constructor(readonly status: number) {
		super(`socket ticket request failed (${status})`);
		this.name = "SocketTicketHttpError";
	}
}

class NodeSocketTicketCache {
	private cached: CachedSocketTicket | null = null;
	private unsupported = false;

	async get(
		host: string,
		token: string,
		vaultId: string,
		fetchImpl: typeof fetch,
	): Promise<CachedSocketTicket> {
		if (this.unsupported) throw new SocketTicketHttpError(404);
		const now = Date.now();
		if (this.cached && this.cached.localExpiresAt - now > TICKET_REFRESH_BUFFER_MS) {
			return this.cached;
		}
		this.cached = await fetchSocketTicket(host, token, vaultId, fetchImpl);
		return this.cached;
	}

	invalidate(): void {
		this.cached = null;
	}

	markUnsupported(): void {
		this.unsupported = true;
		this.cached = null;
	}

	isUnsupported(): boolean {
		return this.unsupported;
	}
}

export class HeadlessSyncClient {
	readonly provider: YSyncProvider;
	private readonly ticketCache = new NodeSocketTicketCache();
	private ticketRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		doc: Y.Doc,
		private readonly options: HeadlessSyncClientOptions,
	) {
		const syncPrefix = `/vault/sync/${encodeURIComponent(options.vaultId)}`;
		this.provider = new YSyncProvider(options.host, options.vaultId, doc, {
			prefix: syncPrefix,
			params: () => this.buildProviderParams(),
			WebSocketPolyfill: options.webSocketPolyfill ?? WebSocket,
			connect: false,
			maxBackoffTime: options.maxBackoffTimeMs ?? DEFAULT_MAX_BACKOFF_MS,
			disableBc: true,
		});

		this.provider.on("status", (event: { status: string }) => {
			this.options.log?.({ kind: "provider-status", status: event.status });
		});
		this.provider.on("custom-message", (message: unknown) => {
			const payload = Array.isArray(message) ? message[0] : message;
			const parsed = parseServerError(payload);
			if (parsed) this.options.log?.(parsed);
		});
	}

	async connect(): Promise<void> {
		await this.provider.connect();
	}

	waitForSync(timeoutMs = this.options.connectTimeoutMs ?? 30_000): Promise<void> {
		if (this.provider.synced) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				clearTimeout(timeout);
				this.provider.off("sync", onSync);
				this.provider.off("custom-message", onCustomMessage);
			};
			const finish = (err?: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (err) reject(err);
				else resolve();
			};
			const onSync = (synced: boolean) => {
				if (synced) finish();
			};
			const onCustomMessage = (message: unknown) => {
				const payload = Array.isArray(message) ? message[0] : message;
				const parsed = parseServerError(payload);
				if (parsed) finish(new Error(`sync server rejected connection: ${parsed.code}`));
			};
			const timeout = setTimeout(() => {
				finish(new Error(`timed out waiting for initial sync after ${timeoutMs}ms`));
			}, timeoutMs);
			this.provider.on("sync", onSync);
			this.provider.on("custom-message", onCustomMessage);
		});
	}

	destroy(): void {
		if (this.ticketRefreshTimer) {
			clearTimeout(this.ticketRefreshTimer);
			this.ticketRefreshTimer = null;
		}
		this.provider.destroy();
	}

	private async buildProviderParams(): Promise<Record<string, string>> {
		const params: Record<string, string> = {
			schemaVersion: String(SCHEMA_VERSION),
			device: this.options.deviceName,
			clientKind: HEADLESS_CLIENT_KIND,
		};

		const ticket = await this.getSocketTicketIfSupported();
		if (ticket) {
			params.ticket = ticket.value;
			this.scheduleTicketRefresh(ticket);
		} else {
			params.token = this.options.token;
		}
		return params;
	}

	private async getSocketTicketIfSupported(): Promise<CachedSocketTicket | null> {
		if (this.ticketCache.isUnsupported()) return null;
		try {
			return await this.ticketCache.get(
				this.options.host,
				this.options.token,
				this.options.vaultId,
				this.options.fetchImpl ?? fetch,
			);
		} catch (err) {
			if (isTicketEndpointUnsupported(err)) {
				this.ticketCache.markUnsupported();
				this.options.log?.({ kind: "provider-ticket-auth-unsupported" });
				return null;
			}
			throw err;
		}
	}

	private scheduleTicketRefresh(ticket: CachedSocketTicket): void {
		if (this.ticketRefreshTimer) clearTimeout(this.ticketRefreshTimer);
		const delay = Math.max(1_000, ticket.localExpiresAt - Date.now() - TICKET_REFRESH_BUFFER_MS);
		this.ticketRefreshTimer = setTimeout(() => {
			void this.refreshTicket();
		}, delay);
		this.options.log?.({
			kind: "provider-ticket-refresh",
			expiresAt: ticket.expiresAt,
			ttlMs: ticket.ttlMs,
		});
	}

	private async refreshTicket(): Promise<void> {
		this.ticketCache.invalidate();
		try {
			const ticket = await this.getSocketTicketIfSupported();
			if (!ticket) return;
			this.provider.url = patchTicketInUrl(this.provider.url, ticket.value);
			this.scheduleTicketRefresh(ticket);
		} catch (err) {
			this.options.log?.({
				kind: "provider-ticket-refresh-failed",
				error: err instanceof Error ? err.message : String(err),
			});
			this.ticketRefreshTimer = setTimeout(() => {
				void this.refreshTicket();
			}, 10_000);
		}
	}
}

function isTicketEndpointUnsupported(err: unknown): boolean {
	return (
		err instanceof SocketTicketHttpError &&
		(err.status === 404 || err.status === 405 || err.status === 501)
	);
}

async function fetchSocketTicket(
	host: string,
	token: string,
	vaultId: string,
	fetchImpl: typeof fetch,
): Promise<CachedSocketTicket> {
	const base = host.replace(/\/$/, "");
	const res = await fetchImpl(`${base}/vault/${encodeURIComponent(vaultId)}/auth/ticket`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
	});

	if (res.status !== 200) {
		throw new SocketTicketHttpError(res.status);
	}

	const body = await res.json() as { ticket?: unknown; expiresAt?: unknown; ttlMs?: unknown };
	if (
		typeof body.ticket !== "string" ||
		typeof body.expiresAt !== "number" ||
		typeof body.ttlMs !== "number" ||
		!Number.isFinite(body.ttlMs) ||
		body.ttlMs <= 0 ||
		body.ttlMs > MAX_REASONABLE_TICKET_TTL_MS
	) {
		throw new Error("socket ticket response malformed");
	}

	const receivedAt = Date.now();
	return {
		value: body.ticket,
		expiresAt: body.expiresAt,
		localExpiresAt: receivedAt + body.ttlMs,
		ttlMs: body.ttlMs,
	};
}

function patchTicketInUrl(url: string, ticketValue: string): string {
	const u = new URL(url);
	u.searchParams.delete("token");
	u.searchParams.set("ticket", ticketValue);
	return u.toString();
}

function parseServerError(value: unknown): HeadlessServerErrorEvent | null {
	if (typeof value !== "string") return null;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (parsed.type !== "error") return null;
		const code = typeof parsed.code === "string" ? parsed.code : "unknown";
		return { kind: "provider-server-error", code, details: parsed };
	} catch {
		return null;
	}
}
