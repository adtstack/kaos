import { createServer, type Server, type Socket } from "node:net";
import { chmod, rm } from "node:fs/promises";
import type { DaemonStatePublisher, HeadlessDaemonStatus } from "./daemonStatePublisher";
import type { HeadlessVaultPoller } from "../core/vaultPoller";

export interface IpcDivergenceVersions {
	local: string | null;
	remote: string | null;
	base?: string | null;
}

export interface IpcDivergenceResolution {
	ok: boolean;
	reason?: string;
	conflictPath?: string;
}

export type IpcPreservedResolution =
	| { status: "completed" }
	| { status: "pending"; message: string };

export interface IpcPluginTarget {
	triggerManualSync?: () => Promise<{ ok: boolean; message?: string }>;
	resolvePreservedUnresolvedEntry?: (path: string, action: "keep-local" | "accept-delete") => Promise<IpcPreservedResolution>;
	loadDivergenceVersionsForPath?: (path: string) => Promise<IpcDivergenceVersions>;
	resolveAttentionDivergence?: (path: string, choice: "server" | "local" | "copy") => Promise<IpcDivergenceResolution>;
}

export interface DaemonIpcServerOptions {
	socketPath: string;
	publisher: DaemonStatePublisher;
	plugin: IpcPluginTarget;
	poller?: Pick<HeadlessVaultPoller, "pollOnce">;
}

export type IpcAttentionChoice =
	| "server"
	| "local"
	| "copy"
	| "keep-local"
	| "accept-delete";

export interface IpcRequest {
	id?: string | number;
	command: "status" | "sync" | "conflicts.list" | "conflicts.resolve" | "attention.diff" | "attention.resolve" | "ping";
	params?: Record<string, unknown>;
}

export interface IpcResponse {
	id?: string | number;
	ok: boolean;
	result?: unknown;
	error?: string;
}

export class DaemonIpcServer {
	private server: Server | null = null;
	public readonly socketPath: string;
	private readonly options: DaemonIpcServerOptions;

	constructor(options: DaemonIpcServerOptions) {
		this.options = options;
		this.socketPath = options.socketPath;
	}

	async start(): Promise<void> {
		await this.cleanupStaleSocket();
		return new Promise((resolve, reject) => {
			const server = createServer((socket) => {
				this.handleConnection(socket);
			});
			server.on("error", (err) => {
				reject(err);
			});
			server.listen(this.socketPath, () => {
				this.server = server;
				chmod(this.socketPath, 0o600)
					.catch(() => undefined)
					.finally(resolve);
			});
		});
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		return new Promise((resolve) => {
			this.server?.close(() => {
				this.server = null;
				rm(this.socketPath, { force: true }).catch(() => undefined).finally(resolve);
			});
		});
	}

	private async cleanupStaleSocket(): Promise<void> {
		await rm(this.socketPath, { force: true }).catch(() => undefined);
	}

	private handleConnection(socket: Socket): void {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("error", () => {
			// Ignore client disconnection errors (EPIPE / ECONNRESET)
		});
		socket.on("data", (chunk: Buffer | string) => {
			void (async () => {
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				buffer += text;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const req = JSON.parse(trimmed) as IpcRequest;
						if (process.env.KAOS_DEBUG_IPC) console.error("[ipc-server-recv]", req.command);
						const resp = await this.handleRequest(req);
						if (process.env.KAOS_DEBUG_IPC) console.error("[ipc-server-reply]", req.command, resp.ok);
						if (socket.writable) {
							socket.write(JSON.stringify(resp) + "\n");
						}
					} catch (err) {
						const errorResp: IpcResponse = {
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						};
						if (socket.writable) {
							socket.write(JSON.stringify(errorResp) + "\n");
						}
					}
				}
			})().catch((err: unknown) => {
				if (process.env.KAOS_DEBUG_IPC) {
					console.error("[ipc-server-data-error]", err);
				}
			});
		});
	}

	private async handleRequest(req: IpcRequest): Promise<IpcResponse> {
		switch (req.command) {
			case "ping": {
				return { id: req.id, ok: true, result: "pong" };
			}
			case "status": {
				const status: HeadlessDaemonStatus = this.options.publisher.collectStatus(true);
				return { id: req.id, ok: true, result: status };
			}
			case "sync": {
				let pollerOk = true;
				if (this.options.poller?.pollOnce) {
					try {
						await this.options.poller.pollOnce();
					} catch (pollerErr) {
						pollerOk = false;
						if (process.env.KAOS_DEBUG_IPC) {
							console.error("[ipc-server-poll-error]", pollerErr);
						}
					}
				}
				let syncResult: { ok: boolean; message?: string } = { ok: true, message: "Sync triggered" };
				if (this.options.plugin.triggerManualSync) {
					syncResult = await this.options.plugin.triggerManualSync();
				}
				await this.options.publisher.publishOnce(true).catch(() => undefined);
				return {
					id: req.id,
					ok: syncResult.ok,
					result: {
						pollerOk,
						...syncResult,
					},
				};
			}
			case "conflicts.list": {
				const status = this.options.publisher.collectStatus(true);
				return {
					id: req.id,
					ok: true,
					result: {
						totalCount: status.attention.totalCount,
						items: status.attention.items,
					},
				};
			}
			case "conflicts.resolve": {
				const path = typeof req.params?.path === "string" ? req.params.path : null;
				const action = req.params?.action;
				if (!path || (action !== "keep-local" && action !== "accept-delete")) {
					return {
						id: req.id,
						ok: false,
						error: "path and valid action (keep-local | accept-delete) are required",
					};
				}
				if (!this.options.plugin.resolvePreservedUnresolvedEntry) {
					return {
						id: req.id,
						ok: false,
						error: "plugin does not support online conflict resolution",
					};
				}
				return this.resolvePreservedEntry(req, path, action);
			}
			case "attention.diff": {
				const path = typeof req.params?.path === "string" ? req.params.path : null;
				if (!path) {
					return { id: req.id, ok: false, error: "path is required" };
				}
				if (!this.options.plugin.loadDivergenceVersionsForPath) {
					return { id: req.id, ok: false, error: "plugin does not support divergence review" };
				}
				const versions = await this.options.plugin.loadDivergenceVersionsForPath(path);
				return { id: req.id, ok: true, result: versions };
			}
			case "attention.resolve": {
				const path = typeof req.params?.path === "string" ? req.params.path : null;
				const choice = req.params?.choice;
				if (!path || typeof choice !== "string") {
					return {
						id: req.id,
						ok: false,
						error: "path and choice (server | local | copy | keep-local | accept-delete) are required",
					};
				}
				if (choice === "keep-local" || choice === "accept-delete") {
					if (!this.options.plugin.resolvePreservedUnresolvedEntry) {
						return { id: req.id, ok: false, error: "plugin does not support online conflict resolution" };
					}
					return this.resolvePreservedEntry(req, path, choice);
				}
				if (choice !== "server" && choice !== "local" && choice !== "copy") {
					return {
						id: req.id,
						ok: false,
						error: "choice must be one of: server | local | copy | keep-local | accept-delete",
					};
				}
				if (!this.options.plugin.resolveAttentionDivergence) {
					return { id: req.id, ok: false, error: "plugin does not support divergence resolution" };
				}
				const resolved = await this.options.plugin.resolveAttentionDivergence(path, choice);
				await this.options.publisher.publishOnce(true).catch(() => undefined);
				if (!resolved.ok) {
					return { id: req.id, ok: false, error: resolved.reason ?? "resolution failed" };
				}
				return { id: req.id, ok: true, result: resolved };
			}
			default: {
				return { id: req.id, ok: false, error: `unknown command: ${(req as { command: string }).command}` };
			}
		}
	}

	private async resolvePreservedEntry(
		req: IpcRequest,
		path: string,
		action: "keep-local" | "accept-delete",
	): Promise<IpcResponse> {
		try {
			const outcome = await this.options.plugin.resolvePreservedUnresolvedEntry?.(path, action);
			if (!outcome || (outcome.status !== "completed" && outcome.status !== "pending")
				|| (outcome.status === "pending" && typeof outcome.message !== "string")) {
				throw new Error("Plugin did not confirm the resolution outcome. Update the plugin and headless host together.");
			}
			return {
				id: req.id,
				ok: true,
				result: {
					path,
					...(req.command === "conflicts.resolve" ? { action } : { choice: action }),
					...outcome,
					...(outcome.status === "completed" ? { resolved: path } : {}),
				},
			};
		} catch (error) {
			return { id: req.id, ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			await this.options.publisher.publishOnce(true).catch(() => undefined);
		}
	}
}
