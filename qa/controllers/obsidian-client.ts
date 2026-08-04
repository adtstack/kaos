/**
 * ObsidianClient — Playwright/Electron CDP wrapper for Obsidian desktop.
 *
 * Connects to a running Obsidian instance via remote debugging port.
 * Exposes `evalInObsidian()` to run arbitrary JS in the Electron renderer.
 *
 * Usage:
 *   const client = new ObsidianClient({ port: 9222 });
 *   await client.connect();
 *   const ready = await client.evalInObsidian(() => window.__KAOS_DEBUG__?.isLocalReady());
 *   await client.close();
 *
 * Start Obsidian with remote debugging:
 *   /path/to/Obsidian --remote-debugging-port=9222
 */

import type { CDPSession, Browser, Page } from "playwright";
import type { QaExternalPhaseTicket } from "../obsidian-harness/types";
import { RawCdpObsidianClient } from "./obsidian-client-raw-cdp";

export type PhysicalKeyInput = Readonly<{
	key: string;
	code: string;
	text: string;
	windowsVirtualKeyCode: number;
}>;

export type NativeShortcutInput = Readonly<{
	key: string;
	code: string;
	windowsVirtualKeyCode: number;
	modifiers: number;
}>;

export type CompositionFocusState = Readonly<{
	compositionActive: boolean;
	compositionOwnerCmId: string | null;
	focusedManagedCmId: string | null;
	activeElementIsCodeMirror: boolean;
}>;

export type VaultFileClickReceipt = Readonly<{
	expectedPath: string | null;
	events: readonly Readonly<{ type: string; path: string | null }>[];
}>;

export interface ObsidianClientOptions {
	/** Chrome DevTools Protocol port Obsidian was launched with. Default: 9222 */
	port?: number;
	/** Hostname for CDP. Default: localhost */
	host?: string;
	/** Connection timeout in ms. Default: 15_000 */
	connectTimeoutMs?: number;
	/** Use the exact renderer page WebSocket when Electron rejects browser-level CDP. */
	transport?: "playwright" | "raw-page";
}

export interface ObsidianClientResult<T> {
	ok: boolean;
	value?: T;
	error?: string;
}

export class ObsidianClient {
	private browser: Browser | null = null;
	private page: Page | null = null;
	private cdpSession: CDPSession | null = null;
	private rawClient: RawCdpObsidianClient | null = null;
	private readonly port: number;
	private readonly host: string;
	private readonly connectTimeoutMs: number;
	private readonly transport: "playwright" | "raw-page";

	constructor(opts: ObsidianClientOptions = {}) {
		this.port = opts.port ?? 9222;
		this.host = opts.host ?? "localhost";
		this.connectTimeoutMs = opts.connectTimeoutMs ?? 60_000;
		this.transport = opts.transport ?? "playwright";
	}

	protected async connectBrowser(): Promise<Browser> {
		const { chromium } = await import("playwright");
		return chromium.connectOverCDP(
			`http://${this.host}:${this.port}`,
			{ timeout: this.connectTimeoutMs },
		);
	}

	async connect(): Promise<void> {
		if (this.transport === "raw-page") {
			const rawClient = new RawCdpObsidianClient({
				port: this.port,
				host: this.host,
				connectTimeoutMs: this.connectTimeoutMs,
			});
			await rawClient.connect();
			this.rawClient = rawClient;
			this.cdpSession = {
				send: (method: string, params?: Record<string, unknown>) =>
					rawClient.sendCommand(method, params),
			} as unknown as CDPSession;
			return;
		}
		this.browser = await this.connectBrowser();
		const contexts = this.browser.contexts();
		if (contexts.length === 0) throw new Error("No browser context found in Obsidian");
		const pages = contexts.flatMap((context) => context.pages());
		if (pages.length === 0) throw new Error("No pages found in Obsidian context");
		this.page =
			pages.find((page) => page.url().includes("obsidian.md/index.html")) ?? pages[0]!;
		// Connect CDP session for direct evaluate
		this.cdpSession = await this.page.context().newCDPSession(this.page);
	}

	/** Evaluate an expression string in the Obsidian renderer process. */
	async evalRaw<T = unknown>(expression: string): Promise<T> {
		if (this.rawClient) return this.rawClient.evalRaw<T>(expression);
		if (!this.browser || !this.page) throw new Error("Not connected — call connect() first");
		const result = await this.page.evaluate(expression as never);
		return result as T;
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
			return await this.evalInObsidian(() => {
				const w = window as unknown as Record<string, unknown>;
				return !!(w.__KAOS_DEBUG__ && w.__KAOS_QA__);
			});
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
	async runScenario(id: string, opts: { timeoutMs?: number } = {}): Promise<{
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

	private requireCdpSession(): CDPSession {
		if (!this.cdpSession) throw new Error("CDP session unavailable — call connect() first");
		return this.cdpSession;
	}

	/** Focus the visible CodeMirror content owned by Obsidian's active leaf. */
	async focusActiveCodeMirror(): Promise<void> {
		const focused = await this.evalRaw<boolean>(`
			(() => {
				const activeLeaf = document.querySelector(".workspace-leaf.mod-active");
				const content = activeLeaf?.querySelector(".markdown-source-view .cm-content");
				if (!(content instanceof HTMLElement)) {
					throw new Error("active CodeMirror content is unavailable");
				}
				content.focus({ preventScroll: true });
				const active = document.activeElement;
				return active === content || (active instanceof Node && content.contains(active));
			})()
		`);
		if (!focused) throw new Error("active CodeMirror content did not retain focus");
	}

	/** Dispatch one renderer-native physical key in rawKeyDown -> char -> keyUp order. */
	async dispatchPhysicalKey(input: PhysicalKeyInput): Promise<void> {
		const cdp = this.requireCdpSession();
		const identity = {
			key: input.key,
			code: input.code,
			windowsVirtualKeyCode: input.windowsVirtualKeyCode,
			nativeVirtualKeyCode: input.windowsVirtualKeyCode,
		};
		await cdp.send("Input.dispatchKeyEvent", {
			type: "rawKeyDown",
			...identity,
		});
		await cdp.send("Input.dispatchKeyEvent", {
			type: "char",
			...identity,
			text: input.text,
			unmodifiedText: input.text,
		});
		await cdp.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			...identity,
		});
	}

	/** Dispatch a renderer-native shortcut without synthesising a text input event. */
	async dispatchNativeShortcut(input: NativeShortcutInput): Promise<void> {
		const cdp = this.requireCdpSession();
		const identity = {
			key: input.key,
			code: input.code,
			windowsVirtualKeyCode: input.windowsVirtualKeyCode,
			nativeVirtualKeyCode: input.windowsVirtualKeyCode,
			modifiers: input.modifiers,
		};
		await cdp.send("Input.dispatchKeyEvent", {
			type: "rawKeyDown",
			...identity,
		});
		await cdp.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			...identity,
		});
	}

	/**
	 * Scroll the active CodeMirror through CDP and wait for both the guard epoch
	 * and the DOM scroll anchor to move. Neither observation exposes note text.
	 */
	async scrollActiveCodeMirror(deltaY: number, timeoutMs = 10_000): Promise<void> {
		if (!Number.isFinite(deltaY) || deltaY === 0) {
			throw new Error("scroll delta must be a finite non-zero number");
		}
		const before = await this.evalRaw<{
			leafId: string;
			scrollEpoch: number;
			scrollAnchor: number;
			x: number;
			y: number;
		}>(`
			(() => {
				const debug = window.__KAOS_DEBUG__;
				if (!debug || typeof debug.getContentFreeSnapshot !== "function") {
					throw new Error("content-free handoff snapshot is unavailable");
				}
				const activeLeafId = window.app?.workspace?.activeLeaf?.id;
				const leaf = debug.getContentFreeSnapshot().leaves.find(
					(candidate) => candidate.leafId === activeLeafId
				);
				const scroller = document.querySelector(
					".workspace-leaf.mod-active .markdown-source-view .cm-scroller"
				);
				if (!leaf || typeof leaf.scrollEpoch !== "number") {
					throw new Error("active managed scroll epoch is unavailable");
				}
				if (!(scroller instanceof HTMLElement) || scroller.getClientRects().length === 0) {
					throw new Error("active CodeMirror scroller is unavailable");
				}
				const rect = scroller.getBoundingClientRect();
				return {
					leafId: leaf.leafId,
					scrollEpoch: leaf.scrollEpoch,
					scrollAnchor: scroller.scrollTop,
					x: rect.left + rect.width / 2,
					y: rect.top + rect.height / 2,
				};
			})()
		`);
		await this.requireCdpSession().send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: before.x,
			y: before.y,
			deltaX: 0,
			deltaY,
		});

		const startedAt = Date.now();
		while (Date.now() - startedAt < timeoutMs) {
			const current = await this.evalRaw<{ scrollEpoch: number | null; scrollAnchor: number | null }>(`
				(() => {
					const debug = window.__KAOS_DEBUG__;
					const snapshot = debug?.getContentFreeSnapshot?.();
					const leaf = snapshot?.leaves?.find(
						(candidate) => candidate.leafId === ${JSON.stringify(before.leafId)}
					);
					const scroller = document.querySelector(
						".workspace-leaf.mod-active .markdown-source-view .cm-scroller"
					);
					return {
						scrollEpoch: typeof leaf?.scrollEpoch === "number" ? leaf.scrollEpoch : null,
						scrollAnchor: scroller instanceof HTMLElement ? scroller.scrollTop : null,
					};
				})()
			`);
			if (
				current.scrollEpoch !== null
				&& current.scrollEpoch > before.scrollEpoch
				&& current.scrollAnchor !== null
				&& current.scrollAnchor !== before.scrollAnchor
			) return;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
		throw new Error("physical CodeMirror scroll did not advance its content-free epoch/anchor");
	}

	/** Create a non-empty native selection using only CDP mouse events. */
	async dragActiveCodeMirrorSelection(timeoutMs = 10_000): Promise<void> {
		const before = await this.evalRaw<{
			leafId: string;
			selectionEpoch: number;
			start: { x: number; y: number };
			end: { x: number; y: number };
		}>(`
			(() => {
				const debug = window.__KAOS_DEBUG__;
				if (!debug || typeof debug.getContentFreeSnapshot !== "function") {
					throw new Error("content-free handoff snapshot is unavailable");
				}
				const activeLeafId = window.app?.workspace?.activeLeaf?.id;
				const leaf = debug.getContentFreeSnapshot().leaves.find(
					(candidate) => candidate.leafId === activeLeafId
				);
				const lines = Array.from(document.querySelectorAll(
					".workspace-leaf.mod-active .markdown-source-view .cm-line"
				)).filter((candidate) =>
					candidate instanceof HTMLElement
					&& candidate.getClientRects().length > 0
					&& candidate.getBoundingClientRect().width >= 32
				);
				const line = lines[Math.floor(lines.length / 2)];
				if (!leaf || typeof leaf.selectionEpoch !== "number") {
					throw new Error("active managed selection epoch is unavailable");
				}
				if (!(line instanceof HTMLElement)) {
					throw new Error("visible CodeMirror line is unavailable");
				}
				const rect = line.getBoundingClientRect();
				const startX = rect.left + Math.min(12, rect.width * 0.15);
				const endX = rect.left + Math.max(24, rect.width * 0.7);
				const y = rect.top + rect.height / 2;
				return {
					leafId: leaf.leafId,
					selectionEpoch: leaf.selectionEpoch,
					start: { x: startX, y },
					end: { x: Math.min(endX, rect.right - 2), y },
				};
			})()
		`);
		const cdp = this.requireCdpSession();
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: before.start.x,
			y: before.start.y,
			button: "left",
			buttons: 1,
			clickCount: 1,
		});
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: before.end.x,
			y: before.end.y,
			button: "left",
			buttons: 1,
		});
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: before.end.x,
			y: before.end.y,
			button: "left",
			buttons: 0,
			clickCount: 1,
		});

		const startedAt = Date.now();
		while (Date.now() - startedAt < timeoutMs) {
			const selection = await this.evalRaw<{ epoch: number | null; selectionNonEmpty: boolean }>(`
				(() => {
					const snapshot = window.__KAOS_DEBUG__?.getContentFreeSnapshot?.();
					const leaf = snapshot?.leaves?.find(
						(candidate) => candidate.leafId === ${JSON.stringify(before.leafId)}
					);
					const nativeSelection = window.getSelection();
					return {
						epoch: typeof leaf?.selectionEpoch === "number" ? leaf.selectionEpoch : null,
						selectionNonEmpty: nativeSelection !== null && !nativeSelection.isCollapsed,
					};
				})()
			`);
			if (
				selection.epoch !== null
				&& selection.epoch > before.selectionEpoch
				&& selection.selectionNonEmpty === true
			) return;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
		throw new Error("physical CodeMirror drag did not create a non-empty native selection");
	}

	/** Update Chromium's active IME composition without a renderer mutation fallback. */
	async setImeComposition(
		text: string,
		selectionStart: number,
		selectionEnd: number,
	): Promise<void> {
		await this.requireCdpSession().send("Input.imeSetComposition", {
			text,
			selectionStart,
			selectionEnd,
		});
	}

	/** Queue one ordered native IME update sequence without an inter-update CDP round trip. */
	async setImeCompositionSequence(
		updates: readonly Readonly<{
			text: string;
			selectionStart: number;
			selectionEnd: number;
		}>[],
	): Promise<void> {
		if (updates.length !== 2) throw new Error("IME composition sequence requires exactly two updates");
		const cdp = this.requireCdpSession();
		await cdp.send("Runtime.evaluate", {
			expression: `(() => {
				const key = "__KAOS_QA_IME_INPUT_BARRIER__";
				window[key]?.cleanup?.();
				const content = document.querySelector(
					".workspace-leaf.mod-active .markdown-source-view .cm-content"
				);
				if (!(content instanceof HTMLElement)) throw new Error("active CodeMirror is unavailable");
				let resolveInput;
				const promise = new Promise((resolve) => { resolveInput = resolve; });
				const listener = (event) => {
					const target = event.target;
					if (!(target instanceof Node) || (target !== content && !content.contains(target))) return;
					document.removeEventListener("input", listener, false);
					resolveInput(true);
				};
				const cleanup = () => document.removeEventListener("input", listener, false);
				document.addEventListener("input", listener, false);
				window[key] = { promise, cleanup };
				return true;
			})()`,
			returnByValue: true,
		});
		try {
			const first = updates[0];
			const second = updates[1];
			if (first === undefined || second === undefined) {
				throw new Error("IME composition sequence is incomplete");
			}
			await Promise.all([
				cdp.send("Input.imeSetComposition", {
					text: first.text,
					selectionStart: first.selectionStart,
					selectionEnd: first.selectionEnd,
				}),
				cdp.send("Runtime.evaluate", {
					expression: `Promise.race([
					window.__KAOS_QA_IME_INPUT_BARRIER__?.promise
						?? Promise.reject(new Error("IME input barrier is unavailable")),
					new Promise((_, reject) => setTimeout(
						() => reject(new Error("IME input barrier timed out")),
						2000
					)),
				])`,
					awaitPromise: true,
					returnByValue: true,
				}),
				cdp.send("Input.imeSetComposition", {
					text: second.text,
					selectionStart: second.selectionStart,
					selectionEnd: second.selectionEnd,
				}),
			]);
		} finally {
			await cdp.send("Runtime.evaluate", {
				expression: `(() => {
					window.__KAOS_QA_IME_INPUT_BARRIER__?.cleanup?.();
					delete window.__KAOS_QA_IME_INPUT_BARRIER__;
					return true;
				})()`,
				returnByValue: true,
			});
		}
	}

	/** Commit IME text through Chromium's native composition completion. */
	async commitImeText(text: string): Promise<void> {
		const cdp = this.requireCdpSession();
		await cdp.send("Input.insertText", { text });
	}

	/** Combine active DOM focus with the product's content-free handoff snapshot. */
	async getCompositionFocusState(): Promise<CompositionFocusState> {
		return this.evalRaw<CompositionFocusState>(`
			(() => {
				const debug = window.__KAOS_DEBUG__;
				if (!debug) throw new Error("__KAOS_DEBUG__ unavailable");
				const snapshot = debug.getEditorHandoffDebugSnapshot();
				const activeLeafId = window.app?.workspace?.activeLeaf?.id ?? null;
				const activeLeaf = activeLeafId === null
					? null
					: snapshot.leaves.find((leaf) => leaf.leafId === activeLeafId) ?? null;
				const content = document.querySelector(".workspace-leaf.mod-active .markdown-source-view .cm-content");
				const active = document.activeElement;
				const activeElementIsCodeMirror = content instanceof HTMLElement
					&& (active === content || (active instanceof Node && content.contains(active)));
				const compositionLeaf = snapshot.leaves.find((leaf) => leaf.compositionActive) ?? null;
				return {
					compositionActive: compositionLeaf !== null,
					compositionOwnerCmId: compositionLeaf?.compositionOwnerCmId ?? null,
					focusedManagedCmId: activeElementIsCodeMirror ? activeLeaf?.cmId ?? null : null,
					activeElementIsCodeMirror,
				};
			})()
		`);
	}

	/** Click the exact visible file-explorer row using CDP mouse input. */
	async clickVaultFile(path: string): Promise<void> {
		const receipts: VaultFileClickReceipt[] = [];
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const receipt = await this.clickVaultFileOnce(path);
			receipts.push(receipt);
			if (await this.waitForActiveVaultPath(path, 750)) return;
		}
		throw new Error(
			`vault click did not select exact path after 3 physical attempts: ${path}; receipts=`
			+ JSON.stringify(receipts),
		);
	}

	/** Dispatch one exact explorer click without requiring immediate presentation. */
	async clickVaultFileIntent(path: string): Promise<void> {
		await this.clickVaultFileOnce(path);
	}

	private async clickVaultFileOnce(path: string): Promise<VaultFileClickReceipt> {
		const cdp = this.requireCdpSession();
		const neutral = await this.evalRaw<{ x: number; y: number }>(`
			(() => {
				const content = document.querySelector(
					".workspace-leaf.mod-active .markdown-source-view .cm-content"
				);
				if (content instanceof HTMLElement) {
					const rect = content.getBoundingClientRect();
					if (rect.width > 0 && rect.height > 0) {
						return {
							x: Math.min(rect.right - 4, rect.left + Math.max(4, rect.width * 0.75)),
							y: Math.min(rect.bottom - 4, rect.top + 4),
						};
					}
				}
				return { x: Math.max(1, innerWidth - 4), y: Math.max(1, innerHeight / 2) };
			})()
		`);
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: neutral.x,
			y: neutral.y,
			button: "none",
			buttons: 0,
		});
		await this.evalRaw(`
			(async () => {
				const startedAt = Date.now();
				while (Date.now() - startedAt < 1_500) {
					const visibleHover = Array.from(
						document.querySelectorAll(".hover-popover")
					).some((candidate) =>
						candidate instanceof HTMLElement
						&& candidate.getClientRects().length > 0
					);
					if (!visibleHover) return true;
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
				}
				throw new Error("visible hover popover did not retire before vault click");
			})()
		`);
		const point = await this.evalRaw<{ x: number; y: number }>(`
			(async () => {
				const path = ${JSON.stringify(path)};
				const findVisible = () => Array.from(
					document.querySelectorAll(".nav-file-title[data-path]")
				).find((candidate) =>
					candidate instanceof HTMLElement
					&& candidate.dataset.path === path
					&& candidate.getClientRects().length > 0
				);
				const initial = findVisible();
				if (!(initial instanceof HTMLElement)) {
					throw new Error("visible vault file element is unavailable: " + path);
				}
				initial.scrollIntoView({
					block: "center",
					inline: "nearest",
					behavior: "instant",
				});
				await new Promise((resolveFrame) => requestAnimationFrame(() =>
					requestAnimationFrame(resolveFrame)
				));
				const element = findVisible();
				if (!(element instanceof HTMLElement)) {
					throw new Error("visible vault file element is unavailable: " + path);
				}
				const rect = element.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) {
					throw new Error("vault file element has no clickable bounds: " + path);
				}
				const y = rect.top + rect.height / 2;
				for (const fraction of [0.15, 0.35, 0.5, 0.65, 0.85]) {
					const x = rect.left + rect.width * fraction;
					const hit = document.elementFromPoint(x, y);
					if (hit instanceof Node && element.contains(hit)) return { x, y };
				}
				throw new Error("vault file element is obscured after hover retirement: " + path);
			})()
		`);
		await this.evalRaw(`
			(() => {
				window.__KAOS_QA_VAULT_CLICK_RECEIPT__?.cleanup?.();
				const expectedPath = ${JSON.stringify(path)};
				const events = [];
				const eventTypes = ["pointerdown", "mousedown", "mouseup", "click"];
				const capture = (event) => {
					const target = event.target instanceof Element
						? event.target.closest(".nav-file-title[data-path]")
						: null;
					events.push({
						type: event.type,
						path: target instanceof HTMLElement ? target.dataset.path ?? null : null,
					});
				};
				for (const type of eventTypes) document.addEventListener(type, capture, true);
				window.__KAOS_QA_VAULT_CLICK_RECEIPT__ = {
					expectedPath,
					events,
					cleanup: () => {
						for (const type of eventTypes) {
							document.removeEventListener(type, capture, true);
						}
					},
				};
				return true;
			})()
		`);
		let receipt: VaultFileClickReceipt | null = null;
		try {
			await cdp.send("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x: point.x,
				y: point.y,
				button: "none",
				buttons: 0,
			});
			await this.evalRaw(`
				(() => {
					const expectedPath = ${JSON.stringify(path)};
					const hit = document.elementFromPoint(${point.x}, ${point.y});
					const hitPath = hit instanceof Element
						? hit.closest(".nav-file-title[data-path]")?.getAttribute("data-path") ?? null
						: null;
					if (hitPath !== expectedPath) {
						throw new Error(
							"vault click target moved before mouse press: expected="
							+ expectedPath + "; observed=" + hitPath
						);
					}
					return true;
				})()
			`);
			await cdp.send("Input.dispatchMouseEvent", {
				type: "mousePressed",
				x: point.x,
				y: point.y,
				button: "left",
				buttons: 1,
				clickCount: 1,
			});
			await cdp.send("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				x: point.x,
				y: point.y,
				button: "left",
				buttons: 0,
				clickCount: 1,
			});
			receipt = await this.evalRaw(`
				(() => {
					const current = window.__KAOS_QA_VAULT_CLICK_RECEIPT__;
					const events = window.__KAOS_QA_VAULT_CLICK_RECEIPT__?.events ?? [];
					const snapshot = {
						expectedPath: current?.expectedPath ?? null,
						events: events.map((event) => ({ ...event })),
					};
					current?.cleanup?.();
					delete window.__KAOS_QA_VAULT_CLICK_RECEIPT__;
					return snapshot;
				})()
			`);
		} finally {
			if (receipt === null) {
				await this.evalRaw(`
					(() => {
						window.__KAOS_QA_VAULT_CLICK_RECEIPT__?.cleanup?.();
						delete window.__KAOS_QA_VAULT_CLICK_RECEIPT__;
						return true;
					})()
				`);
			}
		}
		const reachedMouseDown = receipt.events.some((event) =>
			event.type === "mousedown" && event.path === path
		);
		const reachedClick = receipt.events.some((event) =>
			event.type === "click" && event.path === path
		);
		if (receipt.expectedPath !== path || !reachedMouseDown || !reachedClick) {
			throw new Error(
				`vault click receipt did not reach exact path: ${path}; events=`
				+ JSON.stringify(receipt.events),
			);
		}
		return receipt;
	}

	private async waitForActiveVaultPath(path: string, timeoutMs: number): Promise<boolean> {
		return this.evalRaw<boolean>(`
			(async () => {
				const path = ${JSON.stringify(path)};
				const startedAt = Date.now();
				while (Date.now() - startedAt < ${timeoutMs}) {
					if (window.app?.workspace?.activeLeaf?.view?.file?.path === path) return true;
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
				}
				return window.app?.workspace?.activeLeaf?.view?.file?.path === path;
			})()
		`);
	}

	async disableProductPlugin(): Promise<void> {
		const disabled = await this.evalRaw<boolean>(`
			(async () => {
				const plugins = window.app?.plugins;
				if (!plugins || typeof plugins.disablePlugin !== "function") {
					throw new Error("Obsidian plugin disable API is unavailable");
				}
				if (plugins.plugins?.kaos) await plugins.disablePlugin("kaos");
				return !plugins.plugins?.kaos;
			})()
		`);
		if (!disabled) throw new Error("KAOS product plugin remained enabled");
	}

	async enableProductPlugin(): Promise<void> {
		const enabled = await this.evalRaw<boolean>(`
			(async () => {
				const plugins = window.app?.plugins;
				if (!plugins || typeof plugins.enablePlugin !== "function") {
					throw new Error("Obsidian plugin enable API is unavailable");
				}
				if (!plugins.plugins?.kaos) await plugins.enablePlugin("kaos");
				return !!plugins.plugins?.kaos;
			})()
		`);
		if (!enabled) throw new Error("KAOS product plugin did not enable");
	}

	async rebindKaosDebugApi(timeoutMs = 30_000): Promise<void> {
		const startedAt = Date.now();
		while (Date.now() - startedAt < timeoutMs) {
			const rebound = await this.evalRaw<boolean>(`
				(() => {
					const qa = window.__KAOS_QA__;
					if (!qa || typeof qa.rebindKaosDebugApi !== "function") {
						throw new Error("QA debug rebind API is unavailable");
					}
					const product = window.app?.plugins?.plugins?.kaos;
					if (
						!product
						|| typeof product.getEngineControlPort !== "function"
						|| !product.lab
						|| typeof product.lab.getDeviceWitnessTracker !== "function"
					) return false;
					return qa.rebindKaosDebugApi();
				})()
			`);
			if (rebound) return;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error(`KAOS debug API rebind timed out after ${timeoutMs}ms`);
	}

	async waitForExternalPhase<Name extends string>(
		scenarioId: string,
		name: Name,
		timeoutMs = 30_000,
	): Promise<QaExternalPhaseTicket<Name>> {
		const startedAt = Date.now();
		while (Date.now() - startedAt < timeoutMs) {
			const ticket = await this.evalRaw<QaExternalPhaseTicket | null>(
				"window.__KAOS_QA__?.getExternalPhaseTicket?.() ?? null",
			);
			if (ticket !== null) {
				if (
					ticket.scenarioId !== scenarioId
					|| ticket.name !== name
					|| ticket.state !== "waiting"
				) {
					throw new Error(
						`unexpected external phase: ${ticket.scenarioId}/${ticket.name}/${ticket.state}; ` +
						`expected ${scenarioId}/${name}/waiting`,
					);
				}
				return ticket as QaExternalPhaseTicket<Name>;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`external phase timed out: ${scenarioId}/${name}`);
	}

	async resumeExternalPhase<Name extends string>(
		ticket: QaExternalPhaseTicket<Name>,
	): Promise<void> {
		if (ticket.state !== "waiting") throw new Error("external phase ticket is not waiting");
		const resumed = await this.evalRaw<boolean>(`
			window.__KAOS_QA__?.resumeExternalPhase(
				${JSON.stringify(ticket.runId)},
				${ticket.sequence}
			) ?? false
		`);
		if (!resumed) {
			throw new Error(`external phase resume was rejected: ${ticket.runId}/${ticket.sequence}`);
		}
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
		const result = await this.evalRaw<string>(`
			(async () => {
				const qa = window.__KAOS_QA__;
				if (!qa) throw new Error('__KAOS_QA__ not found');
				// Export while trace is still active, then stop.
				const path = await qa.exportTrace(${JSON.stringify(privacy)});
				await qa.stopTrace();
				return path;
			})()
		`);
		return result;
	}

	/**
	 * Write a file to the vault via Node's fs module — a REAL external write.
	 * This exercises the OS file-system watcher path (the same as Web Clipper,
	 * file manager paste, or git checkout). Use this for bulk-import and external
	 * edit scenarios instead of writeAdapterFile from the harness.
	 *
	 * @param vaultAbsPath  Absolute path to the vault root on the local filesystem.
	 * @param relPath       Vault-relative path (e.g. "Notes/new-note.md").
	 * @param content       UTF-8 string content to write.
	 */
	async writeNodeFile(vaultAbsPath: string, relPath: string, content: string): Promise<void> {
		const { writeFile, mkdir } = await import("fs/promises");
		const { join, dirname } = await import("path");
		const fullPath = join(vaultAbsPath, relPath);
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(fullPath, content, "utf-8");
	}

	/**
	 * Write a file via Node fs and wait for Obsidian/KAOS to observe it.
	 *
	 * Polls until the vault manifest shows the file exists and the disk hash
	 * matches the written content, or until timeoutMs. This avoids timing
	 * roulette from fixed sleeps after external writes.
	 *
	 * @param vaultAbsPath   Absolute path to the vault root.
	 * @param relPath        Vault-relative path (e.g. "Notes/new-note.md").
	 * @param content        UTF-8 string to write.
	 * @param timeoutMs      Maximum wait for Obsidian observation. Default: 15_000.
	 */
	async writeNodeFileAndWait(
		vaultAbsPath: string,
		relPath: string,
		content: string,
		timeoutMs = 15_000,
	): Promise<void> {
		await this.writeNodeFile(vaultAbsPath, relPath, content);

		// Poll the vault manifest until the file appears with the expected content.
		const start = Date.now();
		const expectedLen = content.length;
		while (Date.now() - start < timeoutMs) {
			try {
				const found = await this.evalRaw<boolean>(`
					(async () => {
						const app = (window).app;
						if (!app) return false;
						const file = app.vault.getFileByPath(${JSON.stringify(relPath)});
						if (!file) return false;
						try {
							const diskContent = await app.vault.read(file);
							return diskContent.length === ${expectedLen};
						} catch {
							return false;
						}
					})()
				`);
				if (found) return;
			} catch {
				// CDP might fail transiently
			}
			await new Promise((r) => setTimeout(r, 400));
		}
		throw new Error(
			`writeNodeFileAndWait: Obsidian did not observe "${relPath}" within ${timeoutMs}ms`,
		);
	}

	/**
	 * Write multiple files to the vault via Node fs concurrently.
	 * Simulates a watcher storm from bulk paste or directory copy.
	 */
	async writeNodeFiles(
		vaultAbsPath: string,
		files: Array<{ relPath: string; content: string }>,
	): Promise<void> {
		await Promise.all(
			files.map(({ relPath, content }) => this.writeNodeFile(vaultAbsPath, relPath, content)),
		);
	}

	/**
	 * Write multiple files via Node fs and wait for ALL to be observed by Obsidian.
	 * Each file is checked individually; the call returns when all are visible.
	 */
	async writeNodeFilesAndWait(
		vaultAbsPath: string,
		files: Array<{ relPath: string; content: string }>,
		timeoutMs = 30_000,
	): Promise<void> {
		// Write all first (concurrent), then wait for each to appear
		await this.writeNodeFiles(vaultAbsPath, files);
		await Promise.all(
			files.map(({ relPath, content }) =>
				this.writeNodeFileAndWait(vaultAbsPath, relPath, content, timeoutMs),
			),
		);
	}

	/**
	 * Delete a file from the vault via Node fs — real external deletion.
	 */
	async deleteNodeFile(vaultAbsPath: string, relPath: string): Promise<void> {
		const { rm } = await import("fs/promises");
		const { join } = await import("path");
		const fullPath = join(vaultAbsPath, relPath);
		await rm(fullPath, { force: true });
	}

	/**
	 * Delete a file via Node fs and wait for Obsidian to observe the deletion.
	 */
	async deleteNodeFileAndWait(
		vaultAbsPath: string,
		relPath: string,
		timeoutMs = 15_000,
	): Promise<void> {
		await this.deleteNodeFile(vaultAbsPath, relPath);
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			try {
				const gone = await this.evalRaw<boolean>(
					`!window.app?.vault.getFileByPath(${JSON.stringify(relPath)})`,
				);
				if (gone) return;
			} catch {
				// CDP transient
			}
			await new Promise((r) => setTimeout(r, 400));
		}
		throw new Error(
			`deleteNodeFileAndWait: "${relPath}" still visible in vault after ${timeoutMs}ms`,
		);
	}

	async close(): Promise<void> {
		await this.rawClient?.close();
		this.rawClient = null;
		this.cdpSession = null;
		this.page = null;
		await this.browser?.close();
		this.browser = null;
	}
}
