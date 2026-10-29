#!/usr/bin/env bun
/**
 * Solo IME corruption repro (2026-10-02 user report on 1.13.6).
 *
 * Single device, NO remote writer: reproduces "English/consonants fine,
 * continuous Korean composition loses/garbles text" against the real
 * Chromium IME pipeline via CDP Input.imeSetComposition.
 *
 * Bursts:
 *  A. syllable-combining words, chained with realistic per-key timing,
 *     committed per word (compositionend per word) — user's main flow.
 *  B. rapid lone-consonant flow (ㅁㄴㅇㄹ repeated), per-key composition
 *     commit — the pattern found corrupted in the daily note.
 *
 * After each burst: compare editor vs ytext vs DISK FILE; cardinality of
 * every committed unit must be exact and the three views identical.
 *
 * Usage:
 *   bun run qa/controllers/typing-solo-ime-repro.ts \
 *     --port 9223 --vault /tmp/kaos-qa-a --out /tmp/solo-ime-report.json \
 *     [--rounds 3] [--perKeyMs 14] [--consonantRounds 1] \
 *     [--remote-storm 1|2] [--only-c 1]
 *
 * --remote-storm 1 injects remote-origin "·" writes at random offsets during
 * typing; 2 anchors them at the caret (same-point concurrent insert).
 * --only-c 1 skips bursts A/B, runs only the click/reposition burst with a
 * full flight trace and exports it.
 *
 * Verdict: exit 0 when every typed unit survives exactly once in both the
 * editor and Y.Text and (after settle) on disk.
 */
import { resolve } from "path";
import { readFile, writeFile } from "fs/promises";
import { RawCdpObsidianClient as ObsidianClient } from "./obsidian-client-raw-cdp";

const NOTE_PATH = `QA-scratch/solo-ime-repro-${Date.now().toString(36)}.md`;
const NOTE_BASELINE = "# solo ime repro\n\nbaseline\n";

const WORDS = ["한글입력", "동기화테스트", "잘되는느낌", "근데왜다른", "이제서야"];
const CONSONANTS = "ㅁㄴㅇㄹ".repeat(8);

function parseArgs(argv: string[]): Record<string, string> {
	const parsed: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		const v = argv[i + 1];
		if (k?.startsWith("--") && v && !v.startsWith("--")) {
			parsed[k.slice(2)] = v;
			i++;
		}
	}
	return parsed;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Progressive IME composition of one word: per-jamo preedit updates then commit. */
async function composeWord(
	a: ObsidianClient,
	word: string,
	opts: { perKeyMs: number },
): Promise<void> {
	const jams = word.split("");
	let preedit = "";
	for (const ch of jams) {
		preedit += ch;
		await a.imeSetComposition(preedit);
		await sleep(opts.perKeyMs + Math.random() * 40);
	}
	await a.sendCommand("Input.insertText", { text: word });
	await sleep(40 + Math.random() * 60);
}

/**
 * Realistic macOS 2-set pattern: one composition session per SYLLABLE
 * BLOCK, chained with no gap — pressing the next block's initial consonant
 * commits the previous block (compositionend immediately followed by the
 * next compositionstart).
 */
async function composeWordPerBlock(
	a: ObsidianClient,
	word: string,
	opts: { perKeyMs: number },
): Promise<void> {
	const blocks = word.match(/[가-힣]/g) ?? word.split("");
	for (const block of blocks) {
		const jams = block.split("");
		let preedit = "";
		for (const ch of jams) {
			preedit += ch;
			await a.imeSetComposition(preedit);
			await sleep(opts.perKeyMs + Math.random() * 25);
		}
		// commit this block by typing the next key — insertText ends the session
		await a.sendCommand("Input.insertText", { text: block });
		await sleep(Math.random() * 12); // no gap: next compositionstart races the flush
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const vaultPath = resolve(args.vault ?? "/tmp/kaos-qa-a");
	const port = Number(args.port ?? 9223);
	const outPath = resolve(args.out ?? "/tmp/solo-ime-report.json");
	const remoteStorm = args["remote-storm"] !== undefined && args["remote-storm"] !== "0";
	let stormStop = false;

	const a = new ObsidianClient({ port });
	const report: Record<string, unknown> = { bursts: [] };
	await a.connect();
	await a.waitForQaReady();
	await a.assertVaultBasePath(vaultPath);

	// Fresh note (unique path per run), settled.
	await a.evalRaw(`
		(async () => {
			const qa = window.__KAOS_QA__;
			await qa.createFile(${JSON.stringify(NOTE_PATH)}, ${JSON.stringify(NOTE_BASELINE)});
			await qa.waitForCrdtFile(${JSON.stringify(NOTE_PATH)}, 20000);
			await qa.waitForIdle(20000);
			await qa.openFile(${JSON.stringify(NOTE_PATH)});
		})()
	`);
	// Poll binding health directly (harness helper stalls after heavy prior runs).
	{
		let healthy = false;
		for (let i = 0; i < 60 && !healthy; i++) {
			await sleep(500);
			healthy = await a.evalRaw<boolean>(
				`!!window.__KAOS_DEBUG__?.getEditorBindingHealth(${JSON.stringify(NOTE_PATH)})?.healthy`,
			);
		}
		if (!healthy) throw new Error("editor binding never became healthy");
	}

	if (remoteStorm) {
		// Inject small remote-origin writes into the shared ytext during
		// typing — plugin-indistinguishable from another device's
		// keystrokes. --remote-storm 2 anchors them AT the caret (same-point
		// concurrent insert vs the live composition) instead of random
		// offsets — the 3-way same-anchor merge case.
		const stormMode = Number(args["remote-storm"]);
		void (async () => {
			let n = 0;
			while (!stormStop) {
				await sleep(120 + Math.random() * 260);
				try {
					await a.evalRaw(`
						(() => {
							const p = window.app.plugins.plugins["kaos"];
							const yt = p.vaultSync.getTextForPath(${JSON.stringify(NOTE_PATH)});
							if (!yt) return;
							const at = ${stormMode === 2} ? yt.length : Math.floor(Math.random() * yt.length);
							yt.doc.transact(() => { yt.insert(at, "·"); }, "qa-remote-inject");
						})()
					`);
					n++;
				} catch { /* transient */ }
			}
			console.log(`[solo-ime] storm injections: ${n}`);
		})();
	}

	await a.evalRaw(`
		(() => {
			const view = window.app.workspace.activeEditor;
			const editor = view.editor;
			editor.setCursor(editor.offsetToPos(editor.getValue().length));
			const content = view.containerEl.querySelector(".cm-content");
			if (content instanceof HTMLElement) content.focus();
		})()
	`);

	async function snapshot(): Promise<{ editor: string; ytext: string | null; disk: string | null }> {
		return a.evalRaw<{ editor: string; ytext: string | null; disk: string | null }>(`
			(async () => {
				const p = window.app.plugins.plugins["kaos"];
				const yt = p.vaultSync.getTextForPath?.(${JSON.stringify(NOTE_PATH)});
				const f = app.vault.getFileByPath(${JSON.stringify(NOTE_PATH)});
				const disk = f ? await app.vault.read(f) : null;
				return {
					editor: window.app.workspace.activeEditor?.editor?.getValue() ?? "",
					ytext: yt ? yt.toString() : null,
					disk,
				};
			})()
		`);
	}

	function checkCardinality(text: string | null): { ok: boolean; detail: string[] } {
		if (text === null) return { ok: false, detail: ["null text"] };
		const detail: string[] = [];
		let ok = true;
		const typedAll = expectedA + expectedB + expectedC;
		const units = new Set(typedAll.match(/[가-힣]{2,}|\s|ㅁㄴㅇㄹ/g) ?? []);
		for (const unit of units) {
			if (unit.trim() === "") continue;
			const want = typedAll.split(unit).length - 1;
			const got = text.split(unit).length - 1;
			if (got !== want) {
				ok = false;
				detail.push(`unit ${JSON.stringify(unit)}: want ${want} got ${got}`);
			}
		}
		const conj = (text.match(/ㄴㄹ/g) ?? []).length;
		return { ok, detail };
	}

	const onlyC = args["only-c"] === "1";
	if (onlyC) { await a.evalRaw(`window.__KAOS_QA__.startTrace("full")`).catch(() => {}); }
	// ---------------- Burst A: per-block chained syllable composition ----------------
	const rounds = Number(args.rounds ?? 3);
	let expectedA = "";
	for (let round = 0; round < (onlyC ? 0 : rounds); round++) {
		for (const w of WORDS) {
			await composeWordPerBlock(a, w, { perKeyMs: Number(args.perKeyMs ?? 18) });
			expectedA += w;
			await sleep(30 + Math.random() * 50);
		}
		// word separator: space commits + newline rhythm like real prose
		await a.sendCommand("Input.insertText", { text: " " });
		expectedA += " ";
		await sleep(40 + Math.random() * 60);
	}
	{
		const s = await snapshot();
		const expected = NOTE_BASELINE + expectedA;
		const ok = s.editor === expected && s.ytext === expected;
		console.log(`  A immediate: ok=${ok} editorLen=${s.editor.length} ytextLen=${s.ytext?.length ?? -1}`);
		if (!ok) {
			console.log(`  A expected tail: ${JSON.stringify(expected.slice(-50))}`);
			console.log(`  A editor tail:   ${JSON.stringify(s.editor.slice(-50))}`);
		}
		(report.bursts as unknown[]).push({ burst: "A-immediate", ...s, expectedLen: expected.length });
	}

	// ---------------- Burst B: rapid lone consonants ----------------
	console.log("[solo-ime] burst B: rapid consonants");
	const consonantRounds = Number(args.consonantRounds ?? 1);
	let expectedB = "";
	for (let r = 0; r < consonantRounds; r++) {
		for (const ch of (onlyC ? "" : CONSONANTS).split("")) {
			await a.imeSetComposition(ch);
			await sleep(8 + Math.random() * 18);
			await a.sendCommand("Input.insertText", { text: ch });
			await sleep(8 + Math.random() * 18);
		}
		expectedB += CONSONANTS;
	}
	{
		const s = await snapshot();
		const expected = NOTE_BASELINE + expectedA + expectedB;
		const editorOk = s.editor === expected;
		const mirrorOk = s.ytext === s.editor;
		console.log(`  B immediate: editorOk=${editorOk} mirrorOk=${mirrorOk}`);
		console.log(`  B tail=${JSON.stringify(s.editor.slice(-50))}`);
		(report.bursts as unknown[]).push({ burst: "B-immediate", ...s, expectedLen: expected.length });
	}

	// ---------------- Burst C: clicks interleaved with composition ----------------
	console.log("[solo-ime] burst C: clicks during/between compositions");
	const rect = await a.evalRaw<{ x: number; y: number; w: number; h: number }>(`
		(() => { const el = document.querySelector(".cm-content"); const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height }; })()
	`);
	let expectedC = "";
	// Background/minimized windows report a zero-sized .cm-content rect, so
	// coordinate clicks land at (0,0) and steal focus. Reposition the caret
	// directly instead — same semantic (mid-composition reposition + commit).
	const click = async (relX: number, relY: number) => {
		void relX; void relY;
		await a.evalRaw(`
			(() => {
				const v = window.app.workspace.activeEditor;
				const ed = v.editor;
				const total = ed.getValue().length;
				ed.setCursor(ed.offsetToPos(Math.max(0, Math.floor(total * (0.3 + Math.random() * 0.4)))));
				const cm = v.containerEl.querySelector(".cm-content");
				if (cm instanceof HTMLElement) cm.focus();
			})()
		`);
	};
	for (let i = 0; i < 4; i++) {
		const word = WORDS[i % WORDS.length]!;
		// compose half the word, then CLICK mid-preedit (macOS commits preedit on click)
		const half = Math.max(2, Math.floor(word.length / 2));
		let preedit = "";
		for (const ch of word.slice(0, half).split("")) {
			preedit += ch;
			await a.imeSetComposition(preedit);
			await sleep(15 + Math.random() * 20);
		}
		await click(0.5 + 0.08 * i, 0.3 + 0.12 * i);
		await sleep(30 + Math.random() * 40);
		// after the click the preedit is committed by the IME — type the rest
		await a.sendCommand("Input.insertText", { text: word.slice(0, half) });
		await sleep(10);
		await composeWordPerBlock(a, word.slice(half), { perKeyMs: 15 });
		expectedC += word;
		await sleep(40 + Math.random() * 60);
	}
	{
		const s = await snapshot();
		const expected = NOTE_BASELINE + expectedA + expectedB + expectedC;
		const editorOk = s.editor === expected;
		const mirrorOk = s.ytext === s.editor;
		console.log(`  C immediate: editorOk=${editorOk} mirrorOk=${mirrorOk}`);
		if (!editorOk) {
			console.log(`  C expected tail: ${JSON.stringify(expected.slice(-60))}`);
			console.log(`  C editor tail:   ${JSON.stringify(s.editor.slice(-60))}`);
		}
		(report.bursts as unknown[]).push({ burst: "C-immediate", ...s, expectedLen: expected.length });
	}

	// ---------------- Final settle ----------------
	await a.evalRaw(`window.__KAOS_QA__.waitForIdle(20000)`);
	await sleep(2000);
	if (remoteStorm) stormStop = true;
	{
		const s = await snapshot();
		const expected = NOTE_BASELINE + expectedA + expectedB + expectedC;
		const exactOk = s.editor === expected && s.ytext === expected && s.disk === expected;
		const card = checkCardinality(s.editor);
		const cardYt = checkCardinality(s.ytext);
		const mirrorOk = s.ytext === s.editor;
		const diskOk = s.disk === s.editor;
		const finalOk = remoteStorm ? (card.ok && cardYt.ok && mirrorOk && diskOk) : exactOk;
		console.log(`[solo-ime] FINAL: ${finalOk ? "CONVERGED" : "CORRUPTED"}${remoteStorm ? " (storm mode: cardinality+mirror)" : ""}`);
		console.log(`  cardinality(editor): ${card.ok ? "ok" : card.detail.join("; ")}`);
		console.log(`  cardinality(ytext): ${cardYt.ok ? "ok" : cardYt.detail.join("; ")}`);
		console.log(`  ytext==editor: ${mirrorOk}  disk==editor: ${diskOk}`);
		console.log(`  editor tail: ${JSON.stringify(s.editor.slice(-60))}`);
		if (!finalOk && !remoteStorm) {
			console.log(`  expected tail: ${JSON.stringify(expected.slice(-60))}`);
		}
		console.log(`[solo-ime] FINAL: ${finalOk ? "CONVERGED" : "CORRUPTED"}`);
		console.log(`  editor==expected: ${s.editor === expected}`);
		console.log(`  ytext==editor: ${s.ytext === s.editor}`);
		console.log(`  disk==editor: ${s.disk === s.editor}`);
		if (s.editor !== expected) {
			console.log(`  expected tail: ${JSON.stringify(expected.slice(-60))}`);
			console.log(`  editor tail:   ${JSON.stringify(s.editor.slice(-60))}`);
		}
		report.final = { ...s, expectedLen: expected.length, finalOk };
		report.verdict = finalOk ? "PASS" : "FAIL";
	}

	if (onlyC) {
		try {
			const tracePath = await a.evalRaw<string>(`(async()=>{const t=await window.__KAOS_QA__.exportTrace("full");await window.__KAOS_QA__.stopTrace();return t;})()`);
			console.log(`[solo-ime] trace: ${tracePath}`);
		} catch (e) { console.log("trace export failed:", String(e)); }
	}
	await writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
	console.log(`[solo-ime] report → ${outPath}`);
	process.exit(report.verdict === "PASS" ? 0 : 1);
}

main().catch((err) => {
	console.error("[solo-ime] fatal:", err);
	process.exit(1);
});
