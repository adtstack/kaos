#!/usr/bin/env bun
/**
 * Real Chromium/Obsidian acceptance for an A -> B switch during IME composition.
 *
 * Usage:
 *   bun run qa:editor-transition-ime -- --port 9222 --vault /tmp/kaos-qa-a
 */

import { resolve } from "path";
import { ObsidianClient } from "./obsidian-client";

const SOURCE_PATH = "QA-scratch/transition-ime-a.md";
const TARGET_PATH = "QA-scratch/transition-ime-b.md";
const SOURCE_BASELINE = "SOURCE-A\n";
const TARGET_BASELINE = "TARGET-B\n";
const COMPOSED_TEXT = "한";

function parseArgs(argv: string[]): Record<string, string> {
	const parsed: Record<string, string> = {};
	for (let index = 0; index < argv.length; index++) {
		const key = argv[index];
		const value = argv[index + 1];
		if (key?.startsWith("--") && value && !value.startsWith("--")) {
			parsed[key.slice(2)] = value;
			index++;
		}
	}
	return parsed;
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function cleanupScratch(client: ObsidianClient): Promise<void> {
	await client.evalRaw(`
		(async () => {
			const app = window.app;
			const qa = window.__KAOS_QA__;
			if (!app || !qa) throw new Error("KAOS QA APIs unavailable during cleanup");
			for (const path of [${JSON.stringify(SOURCE_PATH)}, ${JSON.stringify(TARGET_PATH)}]) {
				await qa.closeFile(path);
				if (app.vault.getFileByPath(path)) await qa.deleteFile(path);
			}
			await qa.waitForIdle(15000);
		})()
	`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (!args.vault) {
		throw new Error(
			"Usage: bun run qa:editor-transition-ime -- --port 9222 --vault /tmp/kaos-qa-a",
		);
	}
	const vaultPath = resolve(args.vault);
	const port = Number(args.port ?? 9222);
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		throw new Error(`Invalid --port: ${args.port ?? ""}`);
	}

	const client = new ObsidianClient({ port });
	let safeToMutate = false;
	try {
		await client.connect();
		await client.waitForQaReady();
		const connectedVaultPath = await client.assertVaultBasePath(vaultPath);
		safeToMutate = true;
		await client.evalRaw(`
			(async () => {
				const app = window.app;
				const qa = window.__KAOS_QA__;
				if (!app || !qa) throw new Error("KAOS QA APIs unavailable");
				for (const path of [${JSON.stringify(SOURCE_PATH)}, ${JSON.stringify(TARGET_PATH)}]) {
					await qa.closeFile(path);
					if (app.vault.getFileByPath(path)) await qa.deleteFile(path);
				}
				await qa.createFile(${JSON.stringify(SOURCE_PATH)}, ${JSON.stringify(SOURCE_BASELINE)});
				await qa.createFile(${JSON.stringify(TARGET_PATH)}, ${JSON.stringify(TARGET_BASELINE)});
				await qa.waitForCrdtFile(${JSON.stringify(SOURCE_PATH)}, 15000);
				await qa.waitForCrdtFile(${JSON.stringify(TARGET_PATH)}, 15000);
				await qa.openFile(${JSON.stringify(SOURCE_PATH)});
				await qa.waitForCrdtBinding(${JSON.stringify(SOURCE_PATH)}, 15000);
				const active = app.workspace.activeEditor;
				if (active?.file?.path !== ${JSON.stringify(SOURCE_PATH)}) {
					throw new Error("source editor did not become active");
				}
				const editor = active.editor;
				editor.setCursor(editor.offsetToPos(editor.getValue().length));
				const content = app.workspace.activeLeaf?.view?.containerEl?.querySelector(".cm-content");
				if (!(content instanceof HTMLElement)) throw new Error("CodeMirror content DOM unavailable");
				window.__KAOS_IME_ACCEPTANCE_EVENTS__ = [];
				content.addEventListener("compositionstart", () => {
					window.__KAOS_IME_ACCEPTANCE_EVENTS__.push("start");
				});
				content.addEventListener("compositionend", () => {
					window.__KAOS_IME_ACCEPTANCE_EVENTS__.push("end");
				});
				content.focus();
			})()
		`);

		await client.imeSetComposition(COMPOSED_TEXT);
		const started = await client.evalRaw<boolean>(
			`window.__KAOS_IME_ACCEPTANCE_EVENTS__?.includes("start") === true`,
		);
		if (!started) throw new Error("Chromium did not start an IME composition");

		const switchToTarget = client.evalRaw<void>(`
			(async () => {
				await window.__KAOS_QA__.openFile(${JSON.stringify(TARGET_PATH)});
				await window.__KAOS_QA__.waitForCrdtBinding(${JSON.stringify(TARGET_PATH)}, 15000);
			})()
		`);
		await withTimeout(switchToTarget, "IME A -> B switch");

		const state = await client.evalRaw<{
			source: string;
			target: string;
			targetEditor: string;
			activePath: string | null;
			events: string[];
		}>(`
			(async () => {
				const app = window.app;
				const source = app.vault.getFileByPath(${JSON.stringify(SOURCE_PATH)});
				const target = app.vault.getFileByPath(${JSON.stringify(TARGET_PATH)});
				const active = app.workspace.activeEditor;
				return {
					source: await app.vault.read(source),
					target: await app.vault.read(target),
					targetEditor: active?.editor?.getValue() ?? "",
					activePath: active?.file?.path ?? null,
					events: [...(window.__KAOS_IME_ACCEPTANCE_EVENTS__ ?? [])],
				};
			})()
		`);
		const expectedSource = SOURCE_BASELINE + COMPOSED_TEXT;
		if (state.source !== expectedSource) {
			throw new Error(`source IME content mismatch: ${JSON.stringify(state.source)}`);
		}
		if (state.activePath !== TARGET_PATH) {
			throw new Error(`target did not become active: ${String(state.activePath)}`);
		}
		if (state.target !== TARGET_BASELINE || state.targetEditor !== TARGET_BASELINE) {
			throw new Error(`A content crossed into B: ${JSON.stringify(state)}`);
		}
		if (!state.events.includes("end")) {
			throw new Error(`IME composition did not finish before unload: ${state.events.join(",")}`);
		}

		// Repeated A/B switches must preserve exact path-local bytes.
		await client.evalRaw(`
			(async () => {
				const qa = window.__KAOS_QA__;
				for (let index = 0; index < 10; index++) {
					await qa.openFile(index % 2 === 0
						? ${JSON.stringify(SOURCE_PATH)}
						: ${JSON.stringify(TARGET_PATH)});
				}
				await qa.openFile(${JSON.stringify(SOURCE_PATH)});
				await qa.waitForCrdtBinding(${JSON.stringify(SOURCE_PATH)}, 15000);
			})()
		`);
		const reopenedSource = await client.evalRaw<string>(
			`window.app.workspace.activeEditor?.editor?.getValue() ?? ""`,
		);
		if (reopenedSource !== expectedSource) {
			throw new Error(`source changed after rapid switches: ${JSON.stringify(reopenedSource)}`);
		}

		console.log("PASS editor-transition-ime");
		console.log(JSON.stringify({
			vaultPath: connectedVaultPath,
			port,
			sourcePath: SOURCE_PATH,
			targetPath: TARGET_PATH,
		}));
	} finally {
		try {
			if (safeToMutate) await cleanupScratch(client);
		} finally {
			await client.close().catch(() => undefined);
		}
	}
}

await main();
