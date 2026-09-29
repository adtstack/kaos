#!/usr/bin/env bun
/**
 * e2e acceptance for the composition-aware ySync patch (A2).
 *
 * Scenario: device A holds an UNCOMMITTED Korean IME composition while
 * device B (same note open, CRDT path) inserts text. On the stock ySync
 * plugin the projection lands mid-composition and garbles A's input; with
 * the composition hold + 3-way merge flush both texts must survive verbatim.
 *
 * Prerequisites (see docs/testing/local-multidevice-qa.md):
 *   - worker on :8787 (optionally behind a delay proxy) with both devices claimed/paired
 *   - Obsidian A on CDP :9222 (vault A), Obsidian B on CDP :9223 (vault B)
 *
 * Usage:
 *   bun run qa/controllers/typing-composition-remote-repro.ts \
 *     --port 9222 --port-b 9223 --vault /tmp/kaos-qa-typing --out /tmp/composition-report.json
 */

import { resolve } from "path";
import { writeFile } from "fs/promises";
import { RawCdpObsidianClient as ObsidianClient } from "./obsidian-client-raw-cdp";

const NOTE_PATH = "QA-scratch/composition-remote.md";
const NOTE_BASELINE = "# composition remote repro\n\nbaseline\n";

const A_COMMIT = "한글입력";
const B_REMOTE = "[B-원격]";

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (!args.vault) {
		throw new Error("--vault required (device A vault path)");
	}
	const vaultPath = resolve(args.vault);
	const portA = Number(args.port ?? 9222);
	const portB = Number(args["port-b"] ?? 9223);
	const outPath = resolve(args.out ?? "/tmp/composition-report.json");

	const a = new ObsidianClient({ port: portA });
	const b = new ObsidianClient({ port: portB });
	const report: Record<string, unknown> = { notePath: NOTE_PATH, iterations: [] };
	let safeToMutate = false;
	try {
		await a.connect();
		await b.connect();
		await a.waitForQaReady();
		await b.waitForQaReady();
		await a.assertVaultBasePath(vaultPath);

		// Fresh note, fully settled before the scenario.
		await a.evalRaw(`
			(async () => {
				const qa = window.__KAOS_QA__;
				const app = window.app;
				await qa.closeFile(${JSON.stringify(NOTE_PATH)});
				if (app.vault.getFileByPath(${JSON.stringify(NOTE_PATH)})) await qa.deleteFile(${JSON.stringify(NOTE_PATH)});
				await qa.createFile(${JSON.stringify(NOTE_PATH)}, ${JSON.stringify(NOTE_BASELINE)});
				await qa.waitForCrdtFile(${JSON.stringify(NOTE_PATH)}, 20000);
				await qa.waitForIdle(20000);
				await qa.openFile(${JSON.stringify(NOTE_PATH)});
				await qa.waitForCrdtBinding(${JSON.stringify(NOTE_PATH)}, 20000);
				await qa.waitForIdle(15000);
			})()
		`);
		// B injects its concurrent edit through the CRDT directly (same
		// provider-projection path into A's editor as a real B keystroke).
		// Driving a bound B editor instead trips a stale-leaf rebinding race in
		// the note-delete/recreate setup that is orthogonal to this patch.
		safeToMutate = true;

		// Move A's cursor to the end of the document body.
		await a.evalRaw(`
			(() => {
				const view = window.app.workspace.activeEditor;
				const editor = view.editor;
				editor.setCursor(editor.offsetToPos(editor.getValue().length));
				const content = view.containerEl.querySelector(".cm-content");
				if (content instanceof HTMLElement) content.focus();
			})()
		`);

		let pass = true;
		for (let iteration = 1; iteration <= 5; iteration++) {
			// A starts composing (uncommitted marks).
			await a.imeSetComposition("ㅎ");
			await sleep(90);
			await a.imeSetComposition("한");
			await sleep(90);
			await a.imeSetComposition("한글");
			await sleep(90);
			await a.imeSetComposition("한글입");
			await sleep(90);

			// B inserts remotely mid-composition (CRDT path, non-conf origin so
			// A's plugin sees it as a remote projection).
			await b.evalRaw(`
				(() => {
					const p = window.app.plugins.plugins["kaos"];
					const yt = p.vaultSync.getTextForPath(${JSON.stringify(NOTE_PATH)});
					if (!yt) throw new Error("no ytext on B");
					yt.doc.transact(() => {
						yt.insert(yt.length, ${JSON.stringify("\n" + B_REMOTE + " 줄" + " ")});
					}, "qa-remote-inject");
				})()
			`);
			// Hold window: the projection must be withheld on A.
			await sleep(400);

			// A commits the composition.
			await a.sendCommand("Input.insertText", { text: A_COMMIT });
			await sleep(600);

			const state = await a.evalRaw<{ editor: string; ytext: string | null }>(`
				(() => {
					const d = window.__KAOS_DEBUG__;
					const view = window.app.workspace.activeEditor;
					const p = window.app.plugins.plugins["kaos"];
					const yt = p.vaultSync.getTextForPath?.(${JSON.stringify(NOTE_PATH)});
					return {
						editor: view?.editor?.getValue() ?? "",
						ytext: yt ? yt.toString() : null,
						health: d.getEditorBindingHealth(${JSON.stringify(NOTE_PATH)}),
					};
				})()
			`);
			// Exact-cardinality check: after iteration N the document must
			// contain the composition commit and the remote insert exactly N
			// times each — no loss, no duplication, regardless of interleaving
			// order between the two concurrent writers.
			const countOf = (needle: string) => state.editor.split(needle).length - 1;
			const aOk = countOf(A_COMMIT) === iteration && countOf(B_REMOTE) === iteration;
			const mirrorOk = state.ytext === state.editor;
			const iterPass = aOk && mirrorOk;
			pass = pass && iterPass;
			report.iterations.push({
				iteration,
				editorTail: state.editor.slice(-60),
				aOk,
				mirrorOk,
			});
			console.log(
				`[composition-repro] iter ${iteration}: textOk=${aOk} mirrorOk=${mirrorOk} tail=${JSON.stringify(state.editor.slice(-40))}`,
			);

			// Settle before the next iteration.
			await a.evalRaw(`window.__KAOS_QA__.waitForIdle(15000)`);
			await b.evalRaw(`window.__KAOS_QA__.waitForIdle(15000)`);
		}

		const finalState = await a.evalRaw<{ editor: string; ytext: string | null; health: unknown; b: string }>(`
			(async () => {
				const qa = window.__KAOS_QA__;
				await qa.waitForIdle(20000);
				const d = window.__KAOS_DEBUG__;
				const p = window.app.plugins.plugins["kaos"];
				const yt = p.vaultSync.getTextForPath?.(${JSON.stringify(NOTE_PATH)});
				return {
					editor: window.app.workspace.activeEditor?.editor?.getValue() ?? "",
					ytext: yt ? yt.toString() : null,
					health: d.getEditorBindingHealth(${JSON.stringify(NOTE_PATH)}),
				};
			})()
		`);
		const bFinal = await b.evalRaw<string>(`
			(() => {
				const p = window.app.plugins.plugins["kaos"];
				const yt = p.vaultSync.getTextForPath(${JSON.stringify(NOTE_PATH)});
				return yt ? yt.toString() : "";
			})()
		`);
		const finalMirror = finalState.ytext === finalState.editor;
		const crossDevice = bFinal === finalState.editor;
		const finalCount = (needle: string) => finalState.editor.split(needle).length - 1;
		const cardinalityOk = finalCount(A_COMMIT) === 5 && finalCount(B_REMOTE) === 5;
		const overall = pass && finalMirror && crossDevice && cardinalityOk;
		report.finalCardinality = {
			commitCount: finalCount(A_COMMIT),
			remoteCount: finalCount(B_REMOTE),
			cardinalityOk,
		};
		report.final = {
			editor: finalState.editor,
			ytext: finalState.ytext,
			mirrorOk: finalMirror,
			crossDeviceOk: crossDevice,
			bEditor: bFinal,
			health: finalState.health,
		};
		report.pass = overall;
		await writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
		console.log("[composition-repro] report:", outPath);
		console.log(overall ? "RESULT: PASS — composition survived concurrent remote edits" : "RESULT: FAIL — inspect report");
		process.exitCode = overall ? 0 : 1;
	} finally {
		try {
			if (safeToMutate) {
				await a.evalRaw(`(async () => { await window.__KAOS_QA__.closeFile(${JSON.stringify(NOTE_PATH)}); })()`);
				await b.evalRaw(`(async () => { await window.__KAOS_QA__.closeFile(${JSON.stringify(NOTE_PATH)}); })()`);
			}
		} catch { /* ignore */ }
		await a.close().catch(() => undefined);
		await b.close().catch(() => undefined);
	}
}

await main();
