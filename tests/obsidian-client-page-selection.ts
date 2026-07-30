import assert from "node:assert/strict";
import test from "node:test";
import type { Browser } from "playwright";

import { ObsidianClient } from "../qa/controllers/obsidian-client";
import { RawCdpObsidianClient } from "../qa/controllers/obsidian-client-raw-cdp";
import { isMarkdownEditorLeafForPath } from "../qa/controllers/workspace-leaf-selection";
import {
	atomicallyReadmitSamePathPanesForQa,
	freezeSamePathPaneProjectionForQa,
} from "../qa/obsidian-harness/same-path-admission-fixture";

test("same-path pane selection excludes file-context sidebars", () => {
	const leaf = (id: string, viewType: string) => ({
		id,
		view: {
			file: { path: "QA-same-path-adoption-multi-pane.md" },
			getViewType: () => viewType,
		},
	});
	const leaves = [
		leaf("markdown-a", "markdown"),
		leaf("markdown-b", "markdown"),
		leaf("backlinks", "backlink"),
		leaf("outgoing", "outgoing-link"),
		leaf("outline", "outline"),
	];

	assert.deepEqual(
		leaves
			.filter((candidate) =>
				isMarkdownEditorLeafForPath(
					candidate,
					"QA-same-path-adoption-multi-pane.md",
				),
			)
			.map(({ id }) => id),
		["markdown-a", "markdown-b"],
	);
});

test("QA same-path readmission detaches every pane before admitting one coordinator", () => {
	const views = [
		{ leaf: { id: "pane-b" }, file: { path: "target.md" } },
		{ leaf: { id: "pane-a" }, file: { path: "target.md" } },
		{ leaf: { id: "other" }, file: { path: "other.md" } },
	];
	const bound = new Set(["pane-a", "pane-b"]);
	const calls: string[] = [];
	const ids = atomicallyReadmitSamePathPanesForQa({
		views,
		path: "target.md",
		deviceName: "qa-device",
		manager: {
			unbind(view) {
				calls.push(`unbind:${view.leaf.id}`);
				bound.delete(view.leaf.id);
			},
			bind(view, deviceName) {
				assert.equal(bound.size, 0, "no peer binding may survive coordinator admission");
				calls.push(`bind:${view.leaf.id}:${deviceName}`);
			},
		},
	});

	assert.deepEqual(ids, ["pane-a", "pane-b"]);
	assert.deepEqual(calls, [
		"unbind:pane-a",
		"unbind:pane-b",
		"bind:pane-a:qa-device",
	]);
});

test("QA same-path projection freeze preserves pane locals and restores host methods", async () => {
	let saveCalls = 0;
	let requestCalls = 0;
	const makeView = (id: string, path: string, initial: string) => {
		let value = initial;
		const requestSave = Object.assign(
			() => { requestCalls += 1; },
			{ cancel: () => { requestCalls += 10; } },
		);
		return {
			leaf: { id },
			file: { path },
			editor: { getValue: () => value },
			setViewData(data: string) { value = data; },
			requestSave,
			async save() { saveCalls += 1; },
		};
	};
	const paneA = makeView("a", "target.md", "local-a");
	const paneB = makeView("b", "target.md", "local-b");
	const other = makeView("other", "other.md", "other");
	const originals = {
		setViewData: paneA.setViewData,
		requestSave: paneA.requestSave,
		save: paneA.save,
	};

	const restore = freezeSamePathPaneProjectionForQa(
		[paneA, paneB, other],
		"target.md",
	);
	paneA.setViewData("host-projection", false);
	paneA.requestSave();
	paneA.requestSave.cancel?.();
	await paneA.save();
	other.setViewData("other-updated", false);

	assert.equal(paneA.editor.getValue(), "local-a");
	assert.equal(paneB.editor.getValue(), "local-b");
	assert.equal(other.editor.getValue(), "other-updated");
	assert.equal(requestCalls, 0);
	assert.equal(saveCalls, 0);

	restore();
	assert.equal(paneA.setViewData, originals.setViewData);
	assert.equal(paneA.requestSave, originals.requestSave);
	assert.equal(paneA.save, originals.save);
	paneA.setViewData("restored", false);
	paneA.requestSave();
	await paneA.save();
	assert.equal(paneA.editor.getValue(), "restored");
	assert.equal(requestCalls, 1);
	assert.equal(saveCalls, 1);
});

async function testPlaywrightClientKeepsTheConnectedPage(): Promise<void> {
	const evaluatedOn: string[] = [];
	let sessionPage: unknown;
	let pages: Array<Record<string, unknown>>;
	let context: Record<string, unknown>;

	const starterPage = {
		url: () => "file:///Applications/Obsidian.app/starter.html",
		context: () => context,
		evaluate: async () => {
			evaluatedOn.push("starter");
			return "starter";
		},
	};
	const selectedPage = {
		url: () => "app://obsidian.md/index.html",
		context: () => context,
		evaluate: async () => {
			evaluatedOn.push("selected");
			return "selected";
		},
	};
	const laterFirstPage = {
		url: () => "about:blank",
		context: () => context,
		evaluate: async () => {
			evaluatedOn.push("later-first");
			return "later-first";
		},
	};
	pages = [starterPage, selectedPage];
	context = {
		pages: () => pages,
		newCDPSession: async (page: unknown) => {
			sessionPage = page;
			return {};
		},
	};
	const browser = {
		contexts: () => [context],
		close: async () => undefined,
	} as unknown as Browser;

	class TestObsidianClient extends ObsidianClient {
		protected async connectBrowser(): Promise<Browser> {
			return browser;
		}
	}

	const client = new TestObsidianClient();
	await client.connect();
	assert.equal(sessionPage, selectedPage);
	pages = [laterFirstPage, selectedPage];
	const result = await client.evalRaw<string>("window.location.href");
	assert.equal(result, "selected");
	assert.deepEqual(evaluatedOn, ["selected"]);
	await client.close();
}

interface TestTarget {
	id: string;
	title: string;
	type: string;
	url: string;
	webSocketDebuggerUrl: string;
}

async function connectRawToTargets(targets: TestTarget[]): Promise<string | undefined> {
	const originalFetch = globalThis.fetch;
	const client = new RawCdpObsidianClient();
	let connectedUrl: string | undefined;

	globalThis.fetch = async () =>
		({
			ok: true,
			json: async () => targets,
		}) as Response;

	Object.assign(client as unknown as Record<string, unknown>, {
		connectWebSocket: async (url: string) => {
			connectedUrl = url;
		},
	});

	try {
		await client.connect();
		return connectedUrl;
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function testRawClientPrefersTheObsidianIndexTarget(): Promise<void> {
	const connectedUrl = await connectRawToTargets([
		{
			id: "starter",
			title: "Obsidian",
			type: "page",
			url: "file:///Applications/Obsidian.app/starter.html",
			webSocketDebuggerUrl: "ws://localhost/starter",
		},
		{
			id: "main",
			title: "thirdb.pro",
			type: "page",
			url: "app://obsidian.md/index.html",
			webSocketDebuggerUrl: "ws://localhost/main",
		},
	]);
	assert.equal(connectedUrl, "ws://localhost/main");
}

async function testRawClientPreservesFallbackOrder(): Promise<void> {
	const titleFallback = await connectRawToTargets([
		{
			id: "worker",
			title: "Metadata Worker",
			type: "worker",
			url: "blob:worker",
			webSocketDebuggerUrl: "ws://localhost/worker",
		},
		{
			id: "vault",
			title: "Daily - Obsidian",
			type: "page",
			url: "file:///vault.html",
			webSocketDebuggerUrl: "ws://localhost/title-fallback",
		},
	]);
	assert.equal(titleFallback, "ws://localhost/title-fallback");

	const genericFallback = await connectRawToTargets([
		{
			id: "worker",
			title: "Metadata Worker",
			type: "worker",
			url: "blob:worker",
			webSocketDebuggerUrl: "ws://localhost/worker",
		},
		{
			id: "generic",
			title: "Vault",
			type: "page",
			url: "file:///vault.html",
			webSocketDebuggerUrl: "ws://localhost/generic-fallback",
		},
	]);
	assert.equal(genericFallback, "ws://localhost/generic-fallback");
}

test("Playwright client keeps evaluating on the page selected during connect", async () => {
	await testPlaywrightClientKeepsTheConnectedPage();
});

test("raw CDP client prefers the Obsidian index target over starter.html", async () => {
	await testRawClientPrefersTheObsidianIndexTarget();
});

test("raw CDP client preserves title and generic page fallbacks", async () => {
	await testRawClientPreservesFallbackOrder();
});

test("raw CDP close rejects an in-flight command immediately", async () => {
	const client = new RawCdpObsidianClient();
	let closeCalls = 0;
	Object.assign(client as unknown as Record<string, unknown>, {
		ws: {
			readyState: 1,
			send: () => undefined,
			close: () => { closeCalls += 1; },
		},
	});

	const command = client.sendCommand("Runtime.evaluate", { expression: "42" });
	await client.close();
	await assert.rejects(command, /connection closed/i);
	assert.equal(closeCalls, 1);
});

test("Playwright client emits physical key and IME input only through CDP", async () => {
	const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
	const client = new ObsidianClient();
	Object.assign(client as unknown as Record<string, unknown>, {
		cdpSession: {
			send: async (method: string, params: Record<string, unknown>) => {
				sent.push({ method, params });
			},
		},
	});

	await client.dispatchPhysicalKey({
		key: "x",
		code: "KeyX",
		text: "x",
		windowsVirtualKeyCode: 88,
	});
	await client.setImeComposition("한", 1, 1);
	await client.commitImeText("한");

	assert.deepEqual(sent.map((entry) => [entry.method, entry.params.type ?? null]), [
		["Input.dispatchKeyEvent", "rawKeyDown"],
		["Input.dispatchKeyEvent", "char"],
		["Input.dispatchKeyEvent", "keyUp"],
		["Input.imeSetComposition", null],
		["Input.insertText", null],
	]);
	assert.equal(sent[1]?.params.text, "x");
	assert.equal(sent[3]?.params.text, "한");
});

test("Playwright client pipelines one ordered native IME update sequence", async () => {
	const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
	let releaseFirst: (() => void) | null = null;
	const firstResponse = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let imeCommandCount = 0;
	const client = new ObsidianClient();
	Object.assign(client as unknown as Record<string, unknown>, {
		cdpSession: {
			send: (method: string, params: Record<string, unknown>) => {
				sent.push({ method, params });
				if (method === "Input.imeSetComposition") imeCommandCount += 1;
				return method === "Input.imeSetComposition" && imeCommandCount === 1
					? firstResponse
					: Promise.resolve();
			},
		},
	});

	const pending = client.setImeCompositionSequence([
		{ text: "ㅎ", selectionStart: 1, selectionEnd: 1 },
		{ text: "한", selectionStart: 1, selectionEnd: 1 },
	]);
	await Promise.resolve();
	assert.deepEqual(sent.map((entry) => [entry.method, entry.params.text ?? null]), [
		["Runtime.evaluate", null],
		["Input.imeSetComposition", "ㅎ"],
		["Runtime.evaluate", null],
		["Input.imeSetComposition", "한"],
	]);
	assert.match(String(sent[0]?.params.expression), /__KAOS_QA_IME_INPUT_BARRIER__/);
	assert.equal(sent[2]?.params.awaitPromise, true);
	assert.match(String(sent[2]?.params.expression), /__KAOS_QA_IME_INPUT_BARRIER__/);
	releaseFirst?.();
	await pending;
	assert.equal(sent[4]?.method, "Runtime.evaluate");
	assert.match(String(sent[4]?.params.expression), /delete window\.__KAOS_QA_IME_INPUT_BARRIER__/);
});

test("Playwright client performs a real CDP mouse click for an exact visible vault path", async () => {
	const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
	const evaluatedExpressions: string[] = [];
	const client = new ObsidianClient();
	Object.assign(client as unknown as Record<string, unknown>, {
		browser: {},
		page: {
			evaluate: async (expression: string) => {
				evaluatedExpressions.push(expression);
				if (expression.includes("activeLeaf?.view?.file?.path")) return true;
				if (expression.includes("__KAOS_QA_VAULT_CLICK_RECEIPT__?.events")) {
					return {
						expectedPath: "QA-scratch/B.md",
						events: [
							{ type: "pointerdown", path: "QA-scratch/B.md" },
							{ type: "mousedown", path: "QA-scratch/B.md" },
							{ type: "mouseup", path: "QA-scratch/B.md" },
							{ type: "click", path: "QA-scratch/B.md" },
						],
					};
				}
				return { x: 12.5, y: 24.5 };
			},
		},
		cdpSession: {
			send: async (method: string, params: Record<string, unknown>) => {
				sent.push({ method, params });
			},
		},
	});

	await client.clickVaultFile("QA-scratch/B.md");

	const evaluatedSource = evaluatedExpressions.join("\n");
	assert.match(evaluatedSource, /nav-file-title/);
	assert.match(evaluatedSource, /QA-scratch\/B\.md/);
	assert.match(evaluatedSource, /__KAOS_QA_VAULT_CLICK_RECEIPT__/);
	assert.match(evaluatedSource, /pointerdown/);
	assert.match(evaluatedSource, /mousedown/);
	assert.match(evaluatedSource, /mouseup/);
	assert.match(evaluatedSource, /click/);
	assert.deepEqual(sent, [
		{
			method: "Input.dispatchMouseEvent",
			params: { type: "mouseMoved", x: 12.5, y: 24.5, button: "none", buttons: 0 },
		},
		{
			method: "Input.dispatchMouseEvent",
			params: { type: "mouseMoved", x: 12.5, y: 24.5, button: "none", buttons: 0 },
		},
		{
			method: "Input.dispatchMouseEvent",
			params: {
				type: "mousePressed",
				x: 12.5,
				y: 24.5,
				button: "left",
				buttons: 1,
				clickCount: 1,
			},
		},
		{
			method: "Input.dispatchMouseEvent",
			params: {
				type: "mouseReleased",
				x: 12.5,
				y: 24.5,
				button: "left",
				buttons: 0,
				clickCount: 1,
			},
		},
	]);
});

test("Playwright client retries an exact physical click when Obsidian does not select the path", async () => {
	const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
	let navigationChecks = 0;
	const client = new ObsidianClient();
	Object.assign(client as unknown as Record<string, unknown>, {
		browser: {},
		page: {
			evaluate: async (expression: string) => {
				if (expression.includes("activeLeaf?.view?.file?.path")) {
					navigationChecks += 1;
					return navigationChecks >= 2;
				}
				if (expression.includes("__KAOS_QA_VAULT_CLICK_RECEIPT__?.events")) {
					return {
						expectedPath: "QA-scratch/B.md",
						events: [
							{ type: "mousedown", path: "QA-scratch/B.md" },
							{ type: "click", path: "QA-scratch/B.md" },
						],
					};
				}
				return { x: 12.5, y: 24.5 };
			},
		},
		cdpSession: {
			send: async (method: string, params: Record<string, unknown>) => {
				sent.push({ method, params });
			},
		},
	});

	await client.clickVaultFile("QA-scratch/B.md");

	assert.equal(navigationChecks, 2);
	assert.equal(
		sent.filter(({ method, params }) =>
			method === "Input.dispatchMouseEvent" && params.type === "mousePressed"
		).length,
		2,
	);
});

test("Playwright client rejects a physical vault click without an exact-path click receipt", async () => {
	const client = new ObsidianClient();
	Object.assign(client as unknown as Record<string, unknown>, {
		browser: {},
		page: {
			evaluate: async (expression: string) => {
				if (expression.includes("__KAOS_QA_VAULT_CLICK_RECEIPT__?.events")) {
					return {
						expectedPath: "QA-scratch/B.md",
						events: [{ type: "click", path: "QA-scratch/C.md" }],
					};
				}
				return { x: 12.5, y: 24.5 };
			},
		},
		cdpSession: {
			send: async () => undefined,
		},
	});

	await assert.rejects(
		client.clickVaultFile("QA-scratch/B.md"),
		/vault click receipt did not reach exact path: QA-scratch\/B\.md/,
	);
});

test("external phase polling rejects an unexpected waiting phase and resumes exactly once", async () => {
	const expectedTicket = {
		runId: "run-1",
		sequence: 2,
		scenarioId: "scenario-a",
		name: "phase-b",
		state: "waiting" as const,
	};
	let resumeCalls = 0;
	const client = new ObsidianClient();
	Object.assign(client as unknown as Record<string, unknown>, {
		browser: {},
		page: {
			evaluate: async (expression: string) => {
				if (expression.includes("resumeExternalPhase")) {
					resumeCalls += 1;
					return true;
				}
				return expectedTicket;
			},
		},
	});

	const ticket = await client.waitForExternalPhase("scenario-a", "phase-b", 100);
	assert.deepEqual(ticket, expectedTicket);
	await client.resumeExternalPhase(ticket);
	assert.equal(resumeCalls, 1);

	await assert.rejects(
		client.waitForExternalPhase("scenario-a", "phase-c", 100),
		/unexpected external phase/i,
	);
});
