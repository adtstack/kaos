#!/usr/bin/env node

import { build } from "esbuild";
import { chromium } from "playwright";

export function browserRunFailed({ pageErrors, consoleErrors, result }) {
	return pageErrors.length > 0 || consoleErrors.length > 0 || result === null || result.failed > 0;
}

export async function withTimeout(
	primary,
	timeoutMs,
	message,
	timerApi = {
		setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
		clearTimeout: (timer) => globalThis.clearTimeout(timer),
	},
) {
	let timer;
	try {
		const timeout = new Promise((_, reject) => {
			timer = timerApi.setTimeout(() => reject(new Error(message)), timeoutMs);
			timer?.unref?.();
		});
		return await Promise.race([primary, timeout]);
	} finally {
		if (timer !== undefined) timerApi.clearTimeout(timer);
	}
}

async function selfCheckFailurePredicate() {
	const cases = [
		{ name: "clean", input: { pageErrors: [], consoleErrors: [], result: { failed: 0 } }, expected: false },
		{ name: "page error", input: { pageErrors: ["page"], consoleErrors: [], result: { failed: 0 } }, expected: true },
		{ name: "console error", input: { pageErrors: [], consoleErrors: ["console"], result: { failed: 0 } }, expected: true },
		{ name: "missing result", input: { pageErrors: [], consoleErrors: [], result: null }, expected: true },
		{ name: "failed assertion", input: { pageErrors: [], consoleErrors: [], result: { failed: 1 } }, expected: true },
	];
	const failures = cases.filter((item) => browserRunFailed(item.input) !== item.expected);
	if (failures.length > 0) {
		throw new Error(`browserRunFailed self-check failed: ${failures.map((item) => item.name).join(", ")}`);
	}
	const liveTimers = new Set();
	let nextTimerId = 0;
	const timerApi = {
		setTimeout(callback, delay) {
			const timer = { id: ++nextTimerId, callback, delay, unref() {} };
			liveTimers.add(timer);
			return timer;
		},
		clearTimeout(timer) {
			liveTimers.delete(timer);
		},
	};
	const startedAt = Date.now();
	const primary = await withTimeout(Promise.resolve("primary-won"), 30_000, "self-check timeout", timerApi);
	if (primary !== "primary-won" || liveTimers.size !== 0 || Date.now() - startedAt >= 100) {
		throw new Error("withTimeout self-check failed: primary winner retained a live timer or settled too slowly");
	}
	console.log("PASS: browserRunFailed self-check");
}

if (process.argv.includes("--self-check-failure-predicate")) await selfCheckFailurePredicate();
else await runBrowserSuite();

async function runBrowserSuite() {
const buildResult = await build({
	entryPoints: [new URL("./codemirror-handoff-guard.ts", import.meta.url).pathname],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "chrome120",
	define: {
		"__KAOS_QA_HARNESS_ENABLED__": "true",
	},
	write: false,
});
const output = buildResult.outputFiles[0];
if (!output) throw new Error("esbuild returned no in-memory browser output");

const attempts = [];
if (process.env.KAOS_CHROMIUM_EXECUTABLE) {
	attempts.push({ label: `executable ${process.env.KAOS_CHROMIUM_EXECUTABLE}`, options: { executablePath: process.env.KAOS_CHROMIUM_EXECUTABLE } });
}
attempts.push({ label: "Playwright managed Chromium", options: {} });
attempts.push({ label: "Chrome channel", options: { channel: "chrome" } });

let browser = null;
let browserLabel = "";
const launchErrors = [];
for (const attempt of attempts) {
	try {
		browser = await chromium.launch({ ...attempt.options, headless: true });
		browserLabel = attempt.label;
		break;
	} catch (error) {
		launchErrors.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
if (!browser) {
	throw new Error(`No supported Chromium could launch:\n${launchErrors.join("\n")}`);
}

const page = await browser.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
	if (message.type() === "error") consoleErrors.push(message.text());
	else console.log(message.text());
});

try {
	await page.setContent("<!doctype html><html><body></body></html>");
	await withTimeout(
		page.addScriptTag({ content: output.text }),
		30_000,
		"browser suite timed out after 30 seconds",
	);
	const result = await withTimeout(
		page.evaluate(() => window.__KAOS_TEST_DONE__ ?? Promise.resolve(null)),
		30_000,
		"browser assertions timed out after 30 seconds",
	);
	if (browserRunFailed({ pageErrors, consoleErrors, result })) {
		throw new Error([
			`Browser: ${browserLabel}`,
			...pageErrors.map((error) => `pageerror: ${error}`),
			...consoleErrors.map((error) => `console.error: ${error}`),
			...(result?.failures ?? []).map((failure) => `assertion: ${failure}`),
		].join("\n"));
	}
	console.log(`\nPASS: codemirror-handoff-guard (${result.passed} assertions, ${browserLabel})`);
} finally {
	await browser.close();
}
}
