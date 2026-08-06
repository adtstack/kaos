import assert from "node:assert/strict";
import test from "node:test";
import type { Browser } from "playwright";

import { ObsidianClient } from "../qa/controllers/obsidian-client";
import { RawCdpObsidianClient } from "../qa/controllers/obsidian-client-raw-cdp";

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
