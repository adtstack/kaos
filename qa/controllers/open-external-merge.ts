#!/usr/bin/env bun
/**
 * Real-filesystem acceptance for edits that arrive while a Markdown editor is open.
 *
 * Usage:
 *   bun run qa/controllers/open-external-merge.ts \
 *     --port 9222 --vault /path/to/disposable-vault [--out-dir qa-runs] \
 *     [--case clean|same-line|representation|cursor|quickadd-burst|quickadd-heading|korean-prefix|move-delete|soak]
 */

import { resolve } from "path";
import { isMarkdownConflictArtifactPath } from "../../src/paths/conflictArtifactPath";
import { ArtifactCollector } from "./collect-artifacts";
import { RawCdpObsidianClient as ObsidianClient } from "./obsidian-client-raw-cdp";

const SCENARIO = "open-external-merge";
const TARGET = "QA-scratch/open-external-merge.md";
const ARTIFACT_PREFIX = "QA-scratch/open-external-merge (KAOS conflict";
const OBSERVE_TIMEOUT_MS = 30_000;

interface FileState {
	diskContent: string | null;
	editorContent: string | null;
	diskHash: string | null;
	crdtHash: string | null;
	editorHash: string | null;
	size: number | null;
	artifacts: Array<{ path: string; content: string }>;
}

interface CursorState {
	lineText: string;
	ch: number;
	scrollTop: number;
}

function parseArgs(argv: string[]): Record<string, string> {
	const parsed: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		const value = argv[i + 1];
		if (key?.startsWith("--") && value && !value.startsWith("--")) {
			parsed[key.slice(2)] = value;
			i++;
		}
	}
	return parsed;
}

function normalizeEditorText(content: string): string {
	const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	return withoutBom.replace(/\r\n?/g, "\n");
}

function byteLength(content: string): number {
	return new TextEncoder().encode(content).byteLength;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor<T>(
	label: string,
	probe: () => Promise<T>,
	accept: (value: T) => boolean,
	timeoutMs = OBSERVE_TIMEOUT_MS,
): Promise<T> {
	const startedAt = Date.now();
	let lastValue: T | undefined;
	let lastError: unknown;
	while (Date.now() - startedAt < timeoutMs) {
		try {
			lastValue = await probe();
			lastError = undefined;
			if (accept(lastValue)) return lastValue;
		} catch (error) {
			lastError = error;
		}
		await delay(250);
	}
	const detail = lastError === undefined
		? JSON.stringify(lastValue)
		: String(lastError);
	throw new Error(`${label} timed out after ${timeoutMs}ms; last=${detail}`);
}

async function readState(client: ObsidianClient): Promise<FileState> {
	const state = await client.evalRaw<FileState>(`
		(async () => {
			const app = window.app;
			const debug = window.__KAOS_DEBUG__;
			if (!app || !debug) throw new Error("KAOS QA/debug APIs unavailable");
			const target = ${JSON.stringify(TARGET)};
			const artifactPrefix = ${JSON.stringify(ARTIFACT_PREFIX)};
			const file = app.vault.getFileByPath(target);
			const activeEditor = app.workspace.activeEditor;
			const editor = activeEditor?.file?.path === target ? activeEditor.editor : null;
			const artifacts = [];
			for (const artifact of app.vault.getMarkdownFiles()) {
				if (!artifact.path.startsWith(artifactPrefix)) continue;
				artifacts.push({
					path: artifact.path,
					// Vault.read strips a UTF-8 BOM. Conflict acceptance verifies the
					// exact external representation, so read through the adapter.
					content: await app.vault.adapter.read(artifact.path),
				});
			}
			artifacts.sort((a, b) => a.path.localeCompare(b.path));
			const [diskHash, crdtHash, editorHash] = await Promise.all([
				debug.getDiskHash(target),
				debug.getCrdtHash(target),
				debug.getEditorHash(target),
			]);
			return {
				diskContent: file ? await app.vault.read(file) : null,
				editorContent: editor ? editor.getValue() : null,
				diskHash,
				crdtHash,
				editorHash,
				size: file ? file.stat.size : null,
				artifacts,
			};
		})()
	`);
	state.artifacts = state.artifacts.filter((artifact) =>
		isMarkdownConflictArtifactPath(artifact.path));
	return state;
}

function isConverged(state: FileState, expected: string, artifactCount = 0): boolean {
	return state.diskContent === expected &&
		state.editorContent === expected &&
		state.diskHash !== null &&
		state.diskHash === state.crdtHash &&
		state.diskHash === state.editorHash &&
		state.artifacts.length === artifactCount;
}

async function waitForConvergence(
	client: ObsidianClient,
	label: string,
	expected: string,
	artifactCount = 0,
): Promise<FileState> {
	return waitFor(label, () => readState(client), (state) =>
		isConverged(state, expected, artifactCount));
}

async function waitForQaIdle(client: ObsidianClient, timeoutMs = 15_000): Promise<void> {
	await client.evalRaw(`
		(async () => {
			const qa = window.__KAOS_QA__;
			if (!qa) throw new Error("__KAOS_QA__ unavailable");
			await qa.waitForIdle(${timeoutMs});
		})()
	`);
}

async function assertConvergenceRemainsStable(
	client: ObsidianClient,
	label: string,
	expected: string,
	settled: FileState,
	durationMs = 3_500,
): Promise<void> {
	const artifactCount = settled.artifacts.length;
	const artifactSnapshot = JSON.stringify(settled.artifacts);
	const deadline = Date.now() + durationMs;
	while (Date.now() < deadline) {
		const state = await readState(client);
		if (
			!isConverged(state, expected, artifactCount) ||
			state.diskHash !== settled.diskHash ||
			state.crdtHash !== settled.crdtHash ||
			state.editorHash !== settled.editorHash ||
			JSON.stringify(state.artifacts) !== artifactSnapshot
		) {
			throw new Error(`${label} rolled back after convergence: ${JSON.stringify(state)}`);
		}
		await delay(200);
	}
}

async function waitForEditorAuthority(
	client: ObsidianClient,
	label: string,
	expected: string,
): Promise<FileState> {
	return waitFor(label, () => readState(client), (state) =>
		state.editorContent === expected &&
		state.crdtHash !== null &&
		state.crdtHash === state.editorHash);
}

async function cleanupCase(client: ObsidianClient): Promise<void> {
	await client.evalRaw(`
		(async () => {
			const app = window.app;
			const qa = window.__KAOS_QA__;
			if (!app || !qa) throw new Error("KAOS QA API unavailable");
			await qa.closeFile(${JSON.stringify(TARGET)});
			const paths = app.vault.getMarkdownFiles()
				.map((file) => file.path)
				.filter((path) => path === ${JSON.stringify(TARGET)} ||
					path.startsWith(${JSON.stringify(ARTIFACT_PREFIX)}));
			for (const path of paths) await qa.deleteFile(path);
			await qa.waitForIdle(15000);
		})()
	`);
	await waitFor("case cleanup", () => readState(client), (state) =>
		state.diskContent === null &&
		state.editorContent === null &&
		state.diskHash === null &&
		state.crdtHash === null &&
		state.editorHash === null &&
		state.artifacts.length === 0);
}

async function prepareCase(client: ObsidianClient, baseline: string): Promise<void> {
	await cleanupCase(client);
	await client.evalRaw(`
		(async () => {
			const qa = window.__KAOS_QA__;
			if (!qa) throw new Error("__KAOS_QA__ unavailable");
			const path = ${JSON.stringify(TARGET)};
			await qa.createFile(path, ${JSON.stringify(baseline)});
			await qa.waitForCrdtFile(path, 15000);
			await qa.waitForDiskCrdtConverge(path, 15000);
			await qa.openFile(path);
			await qa.waitForCrdtBinding(path, 15000);
			await qa.waitForIdle(15000);
		})()
	`);
	await waitForConvergence(client, "baseline convergence", baseline);
}

async function replaceEditorText(
	client: ObsidianClient,
	search: string,
	replacement: string,
): Promise<string> {
	return client.evalRaw<string>(`
		(() => {
			const active = window.app?.workspace.activeEditor;
			if (!active || active.file?.path !== ${JSON.stringify(TARGET)}) {
				throw new Error("target editor is not active");
			}
			const editor = active.editor;
			const value = editor.getValue();
			const search = ${JSON.stringify(search)};
			const first = value.indexOf(search);
			if (first < 0 || value.indexOf(search, first + search.length) >= 0) {
				throw new Error("editor replacement anchor must occur exactly once");
			}
			editor.replaceRange(
				${JSON.stringify(replacement)},
				editor.offsetToPos(first),
				editor.offsetToPos(first + search.length),
			);
			return editor.getValue();
		})()
	`);
}

async function appendEditorText(client: ObsidianClient, text: string): Promise<string> {
	return client.evalRaw<string>(`
		(() => {
			const active = window.app?.workspace.activeEditor;
			if (!active || active.file?.path !== ${JSON.stringify(TARGET)}) {
				throw new Error("target editor is not active");
			}
			const editor = active.editor;
			const end = editor.offsetToPos(editor.getValue().length);
			editor.replaceRange(${JSON.stringify(text)}, end);
			return editor.getValue();
		})()
	`);
}

async function readCursorState(client: ObsidianClient): Promise<CursorState> {
	return client.evalRaw<CursorState>(`
		(() => {
			const active = window.app?.workspace.activeEditor;
			if (!active || active.file?.path !== ${JSON.stringify(TARGET)}) {
				throw new Error("target editor is not active");
			}
			const editor = active.editor;
			const cursor = editor.getCursor();
			return {
				lineText: editor.getLine(cursor.line),
				ch: cursor.ch,
				scrollTop: editor.getScrollInfo().top,
			};
		})()
	`);
}

async function runCleanNonOverlap(
	client: ObsidianClient,
	vaultPath: string,
): Promise<void> {
	const baseline = "## 업무\n기본 업무\n\n## 일상\n기본 일상\n";
	const local = "## 업무\n편집기 업무\n\n## 일상\n기본 일상\n";
	const external = "## 업무\n기본 업무\n\n## 일상\n외부 일상\n";
	const expected = "## 업무\n편집기 업무\n\n## 일상\n외부 일상\n";
	await prepareCase(client, baseline);
	const edited = await replaceEditorText(client, "기본 업무", "편집기 업무");
	if (edited !== local) throw new Error(`clean case local body mismatch: ${JSON.stringify(edited)}`);
	await waitForEditorAuthority(client, "clean case local authority", local);
	await client.writeNodeFile(vaultPath, TARGET, external);
	const state = await waitForConvergence(client, "clean non-overlap merge", expected);
	if (state.size !== byteLength(expected)) {
		throw new Error(`clean case size mismatch: ${state.size} != ${byteLength(expected)}`);
	}
}

async function runSameLineConflict(
	client: ObsidianClient,
	vaultPath: string,
): Promise<void> {
	const baseline = "title: base\n";
	const local = "title: local\n";
	const rawExternal = "\ufefftitle: external\r\n";
	await prepareCase(client, baseline);
	const edited = await replaceEditorText(client, "base", "local");
	if (edited !== local) throw new Error(`same-line local body mismatch: ${JSON.stringify(edited)}`);
	await waitForEditorAuthority(client, "same-line local authority", local);
	await client.writeNodeFile(vaultPath, TARGET, rawExternal);
	const state = await waitForConvergence(client, "same-line conflict settlement", local, 1);
	if (state.artifacts[0]?.content !== rawExternal) {
		throw new Error(
			`same-line artifact did not preserve raw disk text: ${JSON.stringify(state.artifacts)}`,
		);
	}
	if (state.diskContent?.includes("<<<<<<<")) {
		throw new Error("same-line primary file contains conflict markers");
	}
}

async function runRepresentationOnly(
	client: ObsidianClient,
	vaultPath: string,
): Promise<void> {
	const normalized = "same logical authority\nsecond line\n";
	const rawExternal = "\ufeffsame logical authority\r\nsecond line\r\n";
	if (normalizeEditorText(rawExternal) !== normalized) {
		throw new Error("representation fixture is not semantically equivalent");
	}
	await prepareCase(client, normalized);
	await client.writeNodeFile(vaultPath, TARGET, rawExternal);
	const state = await waitForConvergence(client, "representation-only settlement", normalized);
	if (state.artifacts.length !== 0) {
		throw new Error(`representation-only write created artifacts: ${JSON.stringify(state.artifacts)}`);
	}
}

async function runCursorScrollUndo(
	client: ObsidianClient,
	vaultPath: string,
): Promise<void> {
	const anchor = "CURSOR-LOGICAL-ANCHOR";
	const filler = Array.from({ length: 180 }, (_, index) => `filler-${index.toString().padStart(3, "0")}`);
	const baseline = [
		"# Cursor acceptance",
		"",
		"## 업무",
		"기본 업무",
		"",
		"## 일상",
		"기본 일상",
		"",
		...filler,
		anchor,
		"tail",
		"",
	].join("\n");
	const local = baseline.replace("기본 업무", "편집기 업무");
	const external = baseline.replace("기본 일상", "외부 일상\n외부 추가 줄");
	const expectedMerged = local.replace("기본 일상", "외부 일상\n외부 추가 줄");
	const expectedAfterUndo = external;

	await prepareCase(client, baseline);
	const edited = await replaceEditorText(client, "기본 업무", "편집기 업무");
	if (edited !== local) throw new Error("cursor case local edit mismatch");
	await client.evalRaw(`
		(() => {
			const active = window.app?.workspace.activeEditor;
			if (!active || active.file?.path !== ${JSON.stringify(TARGET)}) {
				throw new Error("target editor is not active");
			}
			const editor = active.editor;
			const anchor = ${JSON.stringify(anchor)};
			const offset = editor.getValue().indexOf(anchor);
			if (offset < 0) throw new Error("cursor anchor missing");
			editor.setCursor(editor.offsetToPos(offset + 6));
			editor.scrollTo(null, 700);
		})()
	`);
	await waitForEditorAuthority(client, "cursor case local authority", local);
	const before = await waitFor("cursor case initial scroll", () => readCursorState(client), (state) =>
		state.lineText === anchor && state.ch === 6 && state.scrollTop > 0);
	await client.writeNodeFile(vaultPath, TARGET, external);
	await waitForConvergence(client, "cursor case merge", expectedMerged);
	const afterMerge = await readCursorState(client);
	if (afterMerge.lineText !== anchor || afterMerge.ch !== before.ch) {
		throw new Error(`cursor left logical anchor: ${JSON.stringify({ before, afterMerge })}`);
	}
	const scrollDelta = Math.abs(afterMerge.scrollTop - before.scrollTop);
	const scrollTolerance = Math.max(160, before.scrollTop * 0.35);
	if (afterMerge.scrollTop <= 0 || scrollDelta > scrollTolerance) {
		throw new Error(
			`editor scroll jumped after merge: ${JSON.stringify({
				before: before.scrollTop,
				after: afterMerge.scrollTop,
				tolerance: scrollTolerance,
			})}`,
		);
	}

	await client.evalRaw(`
		(() => {
			const active = window.app?.workspace.activeEditor;
			if (!active || active.file?.path !== ${JSON.stringify(TARGET)}) {
				throw new Error("target editor is not active");
			}
			active.editor.undo();
		})()
	`);
	const afterUndo = await waitForConvergence(client, "cursor case undo", expectedAfterUndo);
	if (!afterUndo.diskContent?.includes("외부 추가 줄") || afterUndo.diskContent.includes("편집기 업무")) {
		throw new Error(`undo crossed merge boundary: ${JSON.stringify(afterUndo.diskContent)}`);
	}
}

async function runQuickAddSerialized(client: ObsidianClient): Promise<void> {
	const baseline = "# QuickAdd serialized writes\n\n## Captures\n";
	const additions = [
		"- capture one\n",
		"- capture two\n",
		"- capture three\n",
	];
	const expected = baseline + additions.join("");
	await prepareCase(client, baseline);

	let expectedInput = baseline;
	for (let index = 0; index < additions.length; index += 1) {
		const addition = additions[index];
		const processInput = await client.evalRaw<string>(`
			(async () => {
				const app = window.app;
				if (!app) throw new Error("Obsidian app unavailable");
				const file = app.vault.getFileByPath(${JSON.stringify(TARGET)});
				if (!file) throw new Error("QuickAdd target disappeared");
				let input = "";
				await app.vault.process(file, (current) => {
					input = current;
					return current + ${JSON.stringify(addition)};
				});
				return input;
			})()
		`);
		if (processInput !== expectedInput) {
			throw new Error(
				`QuickAdd serialized write ${index + 1} observed stale input: ` +
				JSON.stringify(processInput),
			);
		}
		expectedInput += addition;
		await waitForConvergence(client, `QuickAdd serialized write ${index + 1}`, expectedInput);
		await waitForQaIdle(client);
		const stable = await waitForConvergence(client, `QuickAdd serialized write ${index + 1} baseline`, expectedInput);
		await assertConvergenceRemainsStable(
			client,
			`QuickAdd serialized write ${index + 1}`,
			expectedInput,
			stable,
		);
	}

	const settled = await waitForConvergence(client, "QuickAdd serialized convergence", expected);
	await assertConvergenceRemainsStable(
		client,
		"QuickAdd serialized writes",
		expected,
		settled,
	);
}

async function runKoreanPrefixConflict(
	client: ObsidianClient,
	vaultPath: string,
): Promise<void> {
	const baseline = [
		"---",
		"date: 2026-08-08",
		"---",
		"",
		"## 일상",
		"오늘은 하루종일 ",
	].join("\n");
	const local = `${baseline}고미`;
	const rawExternal = `${baseline}고민하고 `;
	if (rawExternal.startsWith(local) || !rawExternal.normalize("NFD").startsWith(local.normalize("NFD"))) {
		throw new Error("Korean prefix fixture no longer exercises the Unicode normalization-prefix boundary");
	}
	await prepareCase(client, baseline);
	const edited = await appendEditorText(client, "고미");
	if (edited !== local) throw new Error(`Korean prefix local body mismatch: ${JSON.stringify(edited)}`);
	await waitForEditorAuthority(client, "Korean prefix local authority", local);
	await client.writeNodeFile(vaultPath, TARGET, rawExternal);
	const state = await waitForConvergence(client, "Korean prefix conflict settlement", local, 1);
	if (state.artifacts[0]?.content !== rawExternal) {
		throw new Error(`Korean prefix artifact is not byte-exact: ${JSON.stringify(state.artifacts)}`);
	}
	if (state.diskContent?.includes("<<<<<<<")) throw new Error("Korean prefix primary contains conflict markers");
	await assertConvergenceRemainsStable(client, "Korean prefix conflict", local, state);
}

async function runMoveDeleteConflict(
	client: ObsidianClient,
	vaultPath: string,
): Promise<void> {
	const baseline = "A\nB\nC\n";
	const local = "A\nC\n";
	const rawExternal = "A\nC\nB\n";
	await prepareCase(client, baseline);
	const edited = await replaceEditorText(client, "B\n", "");
	if (edited !== local) throw new Error(`move/delete local body mismatch: ${JSON.stringify(edited)}`);
	await waitForEditorAuthority(client, "move/delete local authority", local);
	await client.writeNodeFile(vaultPath, TARGET, rawExternal);
	const state = await waitForConvergence(client, "move/delete conflict settlement", local, 1);
	if (state.artifacts[0]?.content !== rawExternal) {
		throw new Error(`move/delete artifact is not byte-exact: ${JSON.stringify(state.artifacts)}`);
	}
	if (state.diskContent?.includes("<<<<<<<")) throw new Error("move/delete primary contains conflict markers");
	await assertConvergenceRemainsStable(client, "move/delete conflict", local, state);
}

async function runQuickAddHeadingInsertion(client: ObsidianClient): Promise<void> {
	const baseline = [
		"# Daily note",
		"",
		"## Captures",
		"- existing capture",
		"",
		"## Completed",
		"- existing completion",
		"",
	].join("\n");
	const heading = "## Captures\n";
	const insertion = "- inserted under heading\n";
	const insertionOffset = baseline.indexOf(heading) + heading.length;
	const expected = baseline.slice(0, insertionOffset) + insertion + baseline.slice(insertionOffset);
	await prepareCase(client, baseline);

	const processInput = await client.evalRaw<string>(`
		(async () => {
			const app = window.app;
			if (!app) throw new Error("Obsidian app unavailable");
			const path = ${JSON.stringify(TARGET)};
			const file = app.vault.getFileByPath(path);
			if (!file) throw new Error("QuickAdd target disappeared");
			const heading = ${JSON.stringify(heading)};
			const insertion = ${JSON.stringify(insertion)};
			let input = null;
			await app.vault.process(file, (current) => {
				input = current;
				const first = current.indexOf(heading);
				if (first < 0 || current.indexOf(heading, first + heading.length) >= 0) {
					throw new Error("QuickAdd heading must occur exactly once");
				}
				const offset = first + heading.length;
				return current.slice(0, offset) + insertion + current.slice(offset);
			});
			return input;
		})()
	`);
	if (processInput !== baseline) {
		throw new Error(`QuickAdd heading insertion observed stale input: ${JSON.stringify(processInput)}`);
	}

	const settled = await waitForConvergence(
		client,
		"QuickAdd heading insertion convergence",
		expected,
	);
	await assertConvergenceRemainsStable(
		client,
		"QuickAdd heading insertion",
		expected,
		settled,
	);
}

async function runAlternatingSoak(
	client: ObsidianClient,
	vaultPath: string,
): Promise<void> {
	const baseline = "# Alternating soak\n";
	let expected = baseline;
	await prepareCase(client, baseline);
	for (let cycle = 1; cycle <= 50; cycle++) {
		const source = cycle % 2 === 1 ? "editor" : "filesystem";
		const addition = `${source}-${cycle.toString().padStart(2, "0")}\n`;
		expected += addition;
		if (source === "editor") {
			const edited = await appendEditorText(client, addition);
			if (edited !== expected) {
				throw new Error(`soak cycle ${cycle}: editor body mismatch`);
			}
		} else {
			await client.writeNodeFile(vaultPath, TARGET, expected);
		}
		await waitForConvergence(client, `soak cycle ${cycle}`, expected);
		await waitForQaIdle(client);
		const state = await waitForConvergence(client, `soak cycle ${cycle} post-idle`, expected);
		if (state.size !== byteLength(expected)) {
			throw new Error(`soak cycle ${cycle}: size ${state.size} != ${byteLength(expected)}`);
		}
		await assertConvergenceRemainsStable(client, `soak cycle ${cycle}`, expected, state);
	}

	const final = await waitForConvergence(client, "soak final convergence", expected);
	const finalHash = final.diskHash;
	if (!finalHash || byteLength(expected) > byteLength(baseline) + 1_024) {
		throw new Error(`soak final size is unbounded: ${byteLength(expected)} bytes`);
	}
	await delay(1_500);
	const stable = await readState(client);
	if (!isConverged(stable, expected) || stable.diskHash !== finalHash) {
		throw new Error(`soak hashes/artifacts did not remain stable: ${JSON.stringify(stable)}`);
	}
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	const vaultArg = args.vault;
	if (!vaultArg) {
		console.error(
			"Usage: bun run qa:open-external-merge -- --port 9222 --vault /path/to/disposable-vault " +
			"[--out-dir qa-runs]",
		);
		return 1;
	}
	const vaultPath = resolve(vaultArg);
	const port = Number(args.port ?? 9222);
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		console.error(`Invalid --port: ${args.port ?? ""}`);
		return 1;
	}
	const outDir = resolve(args["out-dir"] ?? "qa-runs");
	const collector = new ArtifactCollector(outDir, SCENARIO, "A", vaultPath);
	await collector.init();
	const client = new ObsidianClient({ port });
	const startedAt = Date.now();
	const errors: string[] = [];
	const warnings: string[] = [];
	const logLines: string[] = [];
	let connected = false;
	let safeToMutate = false;
	const log = (message: string): void => {
		const line = `[${new Date().toISOString()}] ${message}`;
		console.log(line);
		logLines.push(line);
	};

	try {
		log(`Connecting to Obsidian on port ${port}`);
		await client.connect();
		connected = true;
		await client.waitForQaReady(30_000);
		await client.assertVaultBasePath(vaultPath);
		safeToMutate = true;
		await collector.saveManifest(await client.manifest(), "manifest-pre");
		const cases: Array<[string, string, () => Promise<void>]> = [
			["clean", "clean non-overlap", () => runCleanNonOverlap(client, vaultPath)],
			["same-line", "same-line conflict", () => runSameLineConflict(client, vaultPath)],
			["representation", "CRLF/BOM representation", () => runRepresentationOnly(client, vaultPath)],
			["cursor", "cursor, scroll, and undo", () => runCursorScrollUndo(client, vaultPath)],
			["quickadd-burst", "QuickAdd serialized three-write sequence", () => runQuickAddSerialized(client)],
			["quickadd-heading", "QuickAdd heading insertion", () => runQuickAddHeadingInsertion(client)],
			["korean-prefix", "Korean normalization-prefix conflict", () => runKoreanPrefixConflict(client, vaultPath)],
			["move-delete", "move versus delete conflict", () => runMoveDeleteConflict(client, vaultPath)],
			["soak", "50-cycle alternating soak", () => runAlternatingSoak(client, vaultPath)],
		];
		const requestedCase = args.case;
		const selectedCases = requestedCase
			? cases.filter(([id]) => id === requestedCase)
			: cases;
		if (requestedCase && selectedCases.length === 0) {
			throw new Error(`Unknown --case: ${requestedCase}`);
		}
		for (const [, name, run] of selectedCases) {
			log(`START ${name}`);
			await run();
			log(`PASS ${name}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.stack ?? error.message : String(error);
		errors.push(message);
		log(`FAIL ${message}`);
	} finally {
		if (connected) {
			try {
				await collector.saveManifest(await client.manifest(), "manifest-post");
			} catch (error) {
				const message = `post-manifest failed: ${String(error)}`;
				errors.push(message);
				log(message);
			}
			if (safeToMutate) {
				try {
					await cleanupCase(client);
				} catch (error) {
					const message = `cleanup failed: ${String(error)}`;
					errors.push(message);
					log(message);
				}
			}
		}
		await client.close().catch((error) => {
			const message = `client close failed: ${String(error)}`;
			errors.push(message);
			log(message);
		});
		await collector.saveResult({
			passed: errors.length === 0,
			durationMs: Date.now() - startedAt,
			errors,
			warnings,
		});
		await collector.writeLog(logLines.join("\n") + "\n");
		log(`Artifacts: ${collector.runDirectory}`);
	}
	return errors.length === 0 ? 0 : 1;
}

process.exitCode = await main();
