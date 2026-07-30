/**
 * RawCdpObsidianClient — Drop-in replacement for ObsidianClient using raw WebSocket CDP.
 *
 * Bypasses Playwright entirely to avoid Playwright/Electron version incompatibility.
 * Auto-discovers page WebSocket URLs from /json/list and selects the main Obsidian
 * renderer page (not blob workers, DevTools, or metadata cache workers).
 *
 * Implements the same public interface as ObsidianClient so it can be used
 * interchangeably in two-device.ts and other controllers.
 */

import WebSocket from "ws";

export interface RawCdpClientOptions {
	/** Chrome DevTools Protocol port Obsidian was launched with. Default: 9222 */
	port?: number;
	/** Hostname for CDP. Default: localhost */
	host?: string;
	/** Connection timeout in ms. Default: 15_000 */
	connectTimeoutMs?: number;
}

interface CdpTarget {
	id: string;
	title: string;
	type: string;
	url: string;
	webSocketDebuggerUrl: string;
}

export class RawCdpObsidianClient {
	private ws: WebSocket | null = null;
	private msgId = 0;
	private pending = new Map<number, (msg: unknown) => void>();
	private readonly port: number;
	private readonly host: string;
	private readonly connectTimeoutMs: number;

	constructor(opts: RawCdpClientOptions = {}) {
		this.port = opts.port ?? 9222;
		this.host = opts.host ?? "localhost";
		this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
	}

	private rejectPendingCommands(message: string): void {
		const callbacks = [...this.pending.values()];
		this.pending.clear();
		for (const callback of callbacks) {
			callback({ error: { message } });
		}
	}

	/**
	 * Discover and connect to the main Obsidian renderer page.
	 * Selects the page whose URL identifies the Obsidian renderer.
	 * Falls back to an Obsidian title match, then any suitable page target.
	 */
	async connect(): Promise<void> {
		const listUrl = `http://${this.host}:${this.port}/json/list`;
		const res = await fetch(listUrl);
		if (!res.ok) {
			throw new Error(`Failed to fetch ${listUrl}: ${res.status} ${res.statusText}`);
		}
		const targets: CdpTarget[] = await res.json();

		// Pick the main Obsidian page:
		// Priority 1: url contains "obsidian.md/index.html"
		// Priority 2: title contains "Obsidian" and type === "page"
		// Priority 3: first page-type target
		let target: CdpTarget | undefined;

		target = targets.find(
			(t) => t.type === "page" && t.url.includes("obsidian.md/index.html"),
		);
		if (!target) {
			target = targets.find(
				(t) => t.type === "page" && t.title.includes("Obsidian") && !t.title.includes("DevTools"),
			);
		}
		if (!target) {
			target = targets.find(
				(t) => t.type === "page" && !t.url.startsWith("blob:") && !t.title.includes("Worker"),
			);
		}

		if (!target) {
			throw new Error(
				`No suitable Obsidian page found on port ${this.port}. ` +
				`Targets: ${targets.map((t) => `${t.type}:"${t.title}"`).join(", ")}`,
			);
		}

		const wsUrl = target.webSocketDebuggerUrl;
		await this.connectWebSocket(wsUrl);
	}

	private connectWebSocket(url: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`WebSocket connection timeout (${this.connectTimeoutMs}ms) to ${url}`));
			}, this.connectTimeoutMs);

			const socket = new WebSocket(url);
			this.ws = socket;

			socket.on("open", () => {
				clearTimeout(timeout);
				resolve();
			});

			socket.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});

			socket.on("message", (data: Buffer) => {
				const msg = JSON.parse(data.toString()) as { id?: number; [key: string]: unknown };
				if (msg.id !== undefined && this.pending.has(msg.id)) {
					this.pending.get(msg.id)!(msg);
					this.pending.delete(msg.id);
				}
			});

			socket.on("close", () => {
				if (this.ws !== socket) return;
				this.ws = null;
				this.rejectPendingCommands(`CDP connection closed on port ${this.port}`);
			});
		});
	}

	/** Send one command to the exact renderer page CDP target. */
	async sendCommand<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<T> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("Not connected — call connect() first");
		}
		const id = ++this.msgId;
		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP command timeout (60s): ${method} on port ${this.port}`));
			}, 60_000);
			this.pending.set(id, (message: unknown) => {
				clearTimeout(timeout);
				const response = message as {
					result?: T;
					error?: { code?: number; message?: string; data?: unknown };
				};
				if (response.error) {
					reject(new Error(
						`CDP ${method} failed: ${response.error.message ?? JSON.stringify(response.error)}`,
					));
					return;
				}
				resolve((response.result ?? {}) as T);
			});
			this.ws!.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Evaluate an expression string in the Obsidian renderer process. */
	async evalRaw<T = unknown>(expression: string): Promise<T> {
		const result = await this.sendCommand<{
			result?: { value?: unknown; type?: string };
			exceptionDetails?: { text?: string; exception?: { description?: string } };
		}>("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (result.exceptionDetails) {
			const details = result.exceptionDetails;
			throw new Error(
				details.exception?.description
				|| details.text
				|| JSON.stringify(details),
			);
		}
		return result.result?.value as T;
	}

	/**
	 * Evaluate a typed function in the Obsidian renderer.
	 * The function must be serializable (no closures over local variables).
	 */
	async evalInObsidian<T>(fn: () => T | Promise<T>): Promise<T> {
		return this.evalRaw<T>(`(${fn.toString()})()`);
	}

	/** Check that the KAOS debug API and harness API are available. */
	async isQaReady(): Promise<boolean> {
		try {
			return await this.evalRaw<boolean>(
				`!!(window.__KAOS_DEBUG__ && window.__KAOS_QA__)`,
			);
		} catch {
			return false;
		}
	}

	/** Wait until the QA APIs are available. */
	async waitForQaReady(timeoutMs = 30_000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (await this.isQaReady()) return;
			await new Promise((r) => setTimeout(r, 500));
		}
		throw new Error(`waitForQaReady timed out after ${timeoutMs}ms`);
	}

	/** Run a named scenario and return the result. */
	async runScenario(
		id: string,
		opts: { timeoutMs?: number } = {},
	): Promise<{
		passed: boolean;
		durationMs: number;
		errors: string[];
		warnings: string[];
	}> {
		const timeoutMs = opts.timeoutMs ?? 120_000;
		return this.evalRaw(`
			(async () => {
				const qa = window.__KAOS_QA__;
				if (!qa) throw new Error('__KAOS_QA__ not found');
				return qa.run(${JSON.stringify(id)}, ${JSON.stringify({ timeoutMs })});
			})()
		`);
	}

	/** Snapshot the vault manifest. */
	async manifest(): Promise<unknown> {
		return this.evalRaw(`window.__KAOS_QA__?.manifest()`);
	}

	/** Get KAOS debug state. */
	async debugState(): Promise<{
		localReady: boolean;
		providerSynced: boolean;
		reconciled: boolean;
		serverReceiptState: string;
		connectionState: string;
		activeMarkdownPaths: string[];
	}> {
		return this.evalRaw(`
			(function() {
				const d = window.__KAOS_DEBUG__;
				if (!d) return null;
				return {
					localReady: d.isLocalReady(),
					providerSynced: d.isProviderSynced(),
					reconciled: d.isReconciled(),
					serverReceiptState: d.getServerReceiptState(),
					connectionState: d.getConnectionState(),
					activeMarkdownPaths: d.getActiveMarkdownPaths(),
				};
			})()
		`);
	}

	/** Start QA flight trace. */
	async startTrace(mode = "qa-safe"): Promise<void> {
		await this.evalRaw(`window.__KAOS_QA__?.startTrace(${JSON.stringify(mode)})`);
	}

	/** Stop flight trace and return export path. */
	async stopAndExportTrace(privacy: "safe" | "full" = "safe"): Promise<string> {
		return this.evalRaw<string>(`
			(async () => {
				const qa = window.__KAOS_QA__;
				if (!qa) throw new Error('__KAOS_QA__ not found');
				// Export while trace is still active, then stop.
				// Some flight recorder implementations require the trace to be active for export.
				const path = await qa.exportTrace(${JSON.stringify(privacy)});
				await qa.stopTrace();
				return path;
			})()
		`);
	}

	/** Collect build identity from a running instance. */
	async getBuildIdentity(): Promise<{
		pluginVersion: string;
		bundleHash: string;
		obsidianVersion: string;
		electronVersion: string;
		chromeVersion: string;
		platform: string;
		vaultName: string;
	}> {
		return this.evalRaw(`
			(async function() {
				const manifest = app.plugins?.plugins?.kaos?.manifest;
				let bundleHash = "unknown";
				try {
					const basePath = app.vault.adapter.basePath;
					const fs = require("fs");
					const crypto = require("crypto");
					const buf = fs.readFileSync(basePath + "/.obsidian/plugins/kaos/main.js");
					bundleHash = crypto.createHash("sha256").update(buf).digest("hex");
				} catch (e) { /* mobile or missing */ }
				return {
					pluginVersion: manifest?.version ?? "unknown",
					bundleHash: bundleHash,
					obsidianVersion: navigator.userAgent.match(/Obsidian\\/([\\d.]+)/)?.[1] ?? "unknown",
					electronVersion: typeof process !== "undefined" ? process?.versions?.electron ?? "unknown" : "unknown",
					chromeVersion: typeof process !== "undefined" ? process?.versions?.chrome ?? "unknown" : "unknown",
					platform: typeof process !== "undefined" ? process?.platform ?? "unknown" : navigator.platform ?? "unknown",
					vaultName: app.vault?.getName?.() ?? "unknown",
				};
			})()
		`);
	}

	async close(): Promise<void> {
		const socket = this.ws;
		this.ws = null;
		this.rejectPendingCommands(`CDP connection closed on port ${this.port}`);
		socket?.close();
	}
}
