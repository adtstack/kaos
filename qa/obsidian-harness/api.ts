/**
 * QA harness API implementation.
 * Registered as window.__KAOS_QA__ by the harness plugin.
 */

import type { App } from "obsidian";
import type { KaosQaDebugApi } from "../../src/qaDebugApi";
import type {
	QaConsoleApi,
	QaContext,
	QaResult,
	QaRunOptions,
	QaScenario,
	QaExternalPhaseTicket,
	VaultManifest,
	ManifestDiff,
} from "./types";
import {
	createEditorHandoffExternalPhaseCoordinator,
	type EditorHandoffExternalPhaseCoordinator,
} from "./external-phase";
import { analyzeTrace } from "../analyzers/analyzer";
import { sleep, waitForIdle, waitForMemoryReceipt, waitForFile, waitForCrdtFile, waitForDiskCrdtConverge, waitForActiveMarkdownLeaf, waitForCrdtBinding } from "./wait";
import {
	createFile,
	modifyFile,
	appendToFile,
	deleteFile,
	renameFile,
	writeAdapterFile,
	deleteAdapterFile,
} from "./vault-ops";
import {
	openFile,
	closeFile,
	typeIntoFile,
	replaceFileContent,
	runCommand,
} from "./editor-ops";
import {
	assertFileExists,
	assertFileNotExists,
	assertFileContent,
	assertFileHash,
	assertDiskEqualsCrdt,
	assertNoConflictCopies,
} from "./assertions";
import { buildVaultManifest, diffManifests } from "./manifest-builder";

const DEFAULT_IDLE_TIMEOUT = 15_000;
const DEFAULT_RECEIPT_TIMEOUT = 30_000;
const DEFAULT_FILE_TIMEOUT = 15_000;
const qaConsoleApiDisposers = new WeakMap<QaConsoleApi, () => void>();

export function disposeQaConsoleApi(api: QaConsoleApi): void {
	qaConsoleApiDisposers.get(api)?.();
	qaConsoleApiDisposers.delete(api);
}

function getKaos(): KaosQaDebugApi {
	const api = (window as unknown as Record<string, unknown>).__KAOS_DEBUG__ as KaosQaDebugApi | undefined;
	if (!api) throw new Error("window.__KAOS_DEBUG__ not found — is KAOS loaded with qaDebugMode enabled?");
	return api;
}

/**
 * A scenario may deliberately reload the product plugin while the harness
 * remains alive.  Resolve every QA call against the currently mounted debug
 * API so a long-running external-phase scenario never retains the unloaded
 * product instance.
 */
function getReloadSafeKaos(): KaosQaDebugApi {
	return new Proxy({} as KaosQaDebugApi, {
		get(_target, property) {
			const current = getKaos();
			const value = Reflect.get(current as object, property);
			return typeof value === "function" ? value.bind(current) : value;
		},
	});
}

function buildContext(
	app: App,
	signal: AbortSignal,
	awaitExternalPhase: QaContext["awaitExternalPhase"],
): QaContext {
	const kaos = getReloadSafeKaos();
	return {
		app,
		kaos,
		signal,
		awaitExternalPhase,

		phase: (name) => kaos.__qaOnlyEmitPhaseUnsafe(name),

		createFile: (path, content) => createFile(app, path, content),
		modifyFile: (path, content) => modifyFile(app, path, content),
		appendToFile: (path, text) => appendToFile(app, path, text),
		deleteFile: (path, mode) => deleteFile(app, path, mode),
		renameFile: (old, next) => renameFile(app, old, next),

		writeAdapterFile: (path, content) => writeAdapterFile(app, path, content),
		deleteAdapterFile: (path) => deleteAdapterFile(app, path),

		openFile: (path) => openFile(app, path),
		closeFile: (path) => closeFile(app, path),
		typeIntoFile: (path, text) => typeIntoFile(app, path, text),
		replaceFileContent: (path, content) => replaceFileContent(app, path, content),
		runCommand: (id) => runCommand(app, id),

		waitForIdle: (ms) => waitForIdle(kaos, ms ?? DEFAULT_IDLE_TIMEOUT),
		waitForMemoryReceipt: (ms) => waitForMemoryReceipt(kaos, ms ?? DEFAULT_RECEIPT_TIMEOUT),
		waitForFile: (path, ms) => waitForFile(kaos, path, ms ?? DEFAULT_FILE_TIMEOUT),
		waitForCrdtFile: (path, ms) => waitForCrdtFile(kaos, path, ms),
		waitForDiskCrdtConverge: (path, ms) => waitForDiskCrdtConverge(kaos, path, ms),
		waitForActiveMarkdownLeaf: (path, ms) => waitForActiveMarkdownLeaf(app, kaos, path, ms),
		waitForCrdtBinding: (path, ms) => waitForCrdtBinding(kaos, path, ms),
		sleep,

		assert: {
			fileExists: (path) => assertFileExists(app, path),
			fileNotExists: (path) => assertFileNotExists(app, path),
			fileContent: (path, content) => assertFileContent(app, path, content),
			fileHash: (path, hash) => assertFileHash(app, kaos, path, hash),
			diskEqualsCrdt: (path) => assertDiskEqualsCrdt(kaos, path),
			noConflictCopies: (dir) => assertNoConflictCopies(app, dir),
		},
	};
}

export function buildQaConsoleApi(
	app: App,
	scenarioRegistry: Map<string, QaScenario>,
	rebindKaosDebugApi: () => boolean = () => false,
): QaConsoleApi {
	type ActiveQaRun = {
		readonly runId: string;
		readonly controller: AbortController;
		settlement: Promise<QaResult>;
		coordinator: EditorHandoffExternalPhaseCoordinator | null;
	};
	let activeRun: ActiveQaRun | null = null;
	let runSequence = 0;
	let api: QaConsoleApi;

	const failedResult = (id: string, error: string): QaResult => ({
		id,
		passed: false,
		scenarioPassed: false,
		analyzerPassed: false,
		durationMs: 0,
		errors: [error],
		warnings: [],
		tracePath: null,
		analyzerReport: null,
	});

	const executeRun = async (
		record: ActiveQaRun,
		id: string,
		opts?: QaRunOptions,
	): Promise<QaResult> => {
		const scenario = scenarioRegistry.get(id);
		if (!scenario) return failedResult(id, `Unknown scenario: ${id}`);
		if (record.controller.signal.aborted) return failedResult(id, "aborted:superseded");

		const timeoutMs = opts?.timeoutMs ?? 120_000;
		const errors: string[] = [];
		const warnings: string[] = [];
		const start = Date.now();
		let timedOut = false;
		const coordinator = createEditorHandoffExternalPhaseCoordinator({
			runId: record.runId,
			scenarioId: scenario.id,
			signal: record.controller.signal,
		});
		record.coordinator = coordinator;
		const ctx = buildContext(
			app,
			record.controller.signal,
			(name) => coordinator.awaitExternalPhase(name),
		);
		const recordingMode = scenario.traceRecordingMode ?? "qa-safe";
		const exportPrivacy: "safe" | "full" = scenario.traceExportPrivacy ?? "safe";
		let tracePath: string | null = null;
		let analyzerReport: unknown = null;
		let analyzerPassed = true;
		let currentPhase: "setup" | "run" | "assert" = "setup";

		const timeout = setTimeout(() => {
			timedOut = true;
			record.controller.abort(new Error(`timeout:${timeoutMs}ms`));
		}, timeoutMs);

		try {
			try {
				await api.stopTrace();
			} catch {
				// No trace was active.
			}
			try {
				await api.startTrace(recordingMode);
			} catch (traceStartErr) {
				warnings.push(`trace start failed: ${String(traceStartErr)}`);
			}

			let abortListener: (() => void) | null = null;
			const aborted = new Promise<never>((_resolve, reject) => {
				abortListener = () => reject(
					record.controller.signal.reason instanceof Error
						? record.controller.signal.reason
						: new Error("QA run aborted"),
				);
				if (record.controller.signal.aborted) abortListener();
				else record.controller.signal.addEventListener("abort", abortListener, { once: true });
			});
			const throwIfAborted = (): void => {
				if (!record.controller.signal.aborted) return;
				throw record.controller.signal.reason instanceof Error
					? record.controller.signal.reason
					: new Error("QA run aborted");
			};
			const scenarioWork = (async () => {
				throwIfAborted();
				await ctx.phase("setup");
				throwIfAborted();
				currentPhase = "setup";
				await scenario.setup(ctx);
				throwIfAborted();
				await ctx.phase("run");
				throwIfAborted();
				currentPhase = "run";
				await scenario.run(ctx);
				throwIfAborted();
				await ctx.phase("assert");
				throwIfAborted();
				currentPhase = "assert";
				await scenario.assert(ctx);
			})();

			try {
				await Promise.race([scenarioWork, aborted]);
			} catch (error) {
				coordinator.rejectCurrent(
					error instanceof Error ? error : new Error(String(error)),
				);
				await scenarioWork.catch(() => undefined);
				if (record.controller.signal.aborted) {
					const reason = timedOut
						? `timeout:${timeoutMs}ms`
						: `aborted:${record.controller.signal.reason instanceof Error
							? record.controller.signal.reason.message
							: "superseded"}`;
					errors.push(reason);
				} else {
					errors.push(`${currentPhase}:${error instanceof Error ? error.message : String(error)}`);
				}
			} finally {
				if (abortListener) {
					record.controller.signal.removeEventListener("abort", abortListener);
				}
			}

			coordinator.rejectCurrent(new Error("scenario lifecycle settled"));
			try {
				await ctx.phase("cleanup");
			} catch (phaseError) {
				warnings.push(`cleanup phase: ${String(phaseError)}`);
			}

			try {
				const bundle = await api.exportTraceWithAnalyzer(exportPrivacy, scenario.id);
				tracePath = bundle.tracePath;
				analyzerReport = bundle.report;
				const reportPassed = (analyzerReport as { passed?: boolean } | null)?.passed;
				analyzerPassed = reportPassed !== false;
				if (!analyzerPassed) warnings.push("analyzer found hard failures in trace");
			} catch (traceErr) {
				warnings.push(`trace export/analyzer failed: ${String(traceErr)}`);
			} finally {
				try {
					await api.stopTrace();
				} catch (traceStopErr) {
					warnings.push(`trace stop failed: ${String(traceStopErr)}`);
				}
			}

			try {
				await scenario.cleanup?.(ctx);
			} catch (cleanErr) {
				warnings.push(`cleanup: ${String(cleanErr)}`);
			}
		} finally {
			clearTimeout(timeout);
			coordinator.dispose(new Error("scenario lifecycle complete"));
			if (record.coordinator === coordinator) record.coordinator = null;
		}

		const scenarioPassed = errors.length === 0;
		const passed = scenarioPassed && analyzerPassed;
		const result: QaResult = {
			id,
			passed,
			scenarioPassed,
			analyzerPassed,
			durationMs: Date.now() - start,
			errors,
			warnings,
			tracePath,
			analyzerReport,
		};
		console.log(`[KAOS QA] ${passed ? "✓" : "✗"} ${id} (${result.durationMs}ms)`);
		return result;
	};

	api = {
		help(): void {
			const methods = [
				"help()                               — show this message",
				"scenarios()                          — list registered scenario IDs",
				"run(id, opts?)                       — run a scenario (returns QaResult with scenarioPassed+analyzerPassed)",
				"createFile(path, content)            — create/overwrite via Obsidian API",
				"modifyFile(path, content)            — modify via Obsidian API",
				"appendToFile(path, text)             — append via Obsidian API",
				"deleteFile(path)                     — delete via Obsidian API",
				"renameFile(old, new)                 — rename via Obsidian API",
				"writeAdapterFile(path, content)      — write via Obsidian adapter (NOT real external)",
				"deleteAdapterFile(path)              — delete via Obsidian adapter",
				"openFile(path)                       — open in MarkdownView",
				"closeFile(path)                      — close leaf",
				"typeIntoFile(path, text)             — type character-by-character into editor",
				"replaceFileContent(path, content)    — editor.setValue() (blunt — setup only)",
				"runCommand(commandId)                — execute Obsidian command",
				"waitForIdle(ms?)                     — wait for KAOS idle state",
				"kaos.getReceiptSnapshot()            — snapshot receipt state before an action",
				"kaos.waitForReceiptAfter(ts, ms)     — action-relative receipt wait (preferred)",
				"kaos.disconnectProvider(reason?)     — real offline disconnect",
				"kaos.connectProvider(reason?)        — reconnect provider",
				"kaos.waitForProviderDisconnected(ms) — wait for confirmed disconnect",
				"waitForMemoryReceipt(ms?)            — [deprecated] global receipt wait",
				"waitForFile(path, ms?)               — wait for file to appear on disk",
				"waitForCrdtBinding(path, ms?)         — wait for healthy CRDT editor binding",
				"assertFileExists(path)               — throws if not found",
				"assertFileNotExists(path)            — throws if found",
				"assertFileHash(path, hash)           — throws if disk hash mismatches",
				"assertDiskEqualsCrdt(path)           — throws if disk ≠ CRDT",
				"assertNoConflictCopies(dir?)         — throws if conflict copies found",
				"manifest()                           — snapshot current vault",
				"compareManifest(expected)            — diff two manifests",
				"startTrace(recordingMode?, secret?)  — start QA flight trace",
				"stopTrace()                          — stop flight trace",
				"exportTrace(exportPrivacy?)          — export flight trace (returns path)",
				"analyzeTrace(tracePath, scenarioId?) — run analyzer on a trace file",
				"exportTraceWithAnalyzer(privacy?)    — export + analyze in one call",
				"plugins()                            — list installed plugins",
			];
			console.log("[KAOS QA]\n" + methods.join("\n"));
		},

		scenarios(): string[] {
			return [...scenarioRegistry.keys()];
		},

		run(id, opts?: QaRunOptions): Promise<QaResult> {
			const predecessor = activeRun;
			predecessor?.controller.abort(new Error("superseded"));
			const controller = new AbortController();
			const record: ActiveQaRun = {
				runId: `qa-run-${Date.now().toString(36)}-${++runSequence}`,
				controller,
				settlement: Promise.resolve(failedResult(id, "run-not-started")),
				coordinator: null,
			};
			record.settlement = (async () => {
				if (predecessor) await predecessor.settlement.catch(() => undefined);
				return executeRun(record, id, opts);
			})();
			activeRun = record;
			const clearOwnedRun = (): void => {
				if (activeRun === record) activeRun = null;
			};
			void record.settlement.then(clearOwnedRun, clearOwnedRun);
			return record.settlement;
		},

		getExternalPhaseTicket(): QaExternalPhaseTicket | null {
			return activeRun?.coordinator?.getExternalPhaseTicket() ?? null;
		},

		resumeExternalPhase(runId: string, sequence: number): boolean {
			return activeRun?.coordinator?.resumeExternalPhase(runId, sequence) ?? false;
		},

		rebindKaosDebugApi(): boolean {
			return rebindKaosDebugApi();
		},

		// Vault ops
		createFile: (path, content) => createFile(app, path, content),
		modifyFile: (path, content) => modifyFile(app, path, content),
		appendToFile: (path, text) => appendToFile(app, path, text),
		deleteFile: (path, mode) => deleteFile(app, path, mode),
		renameFile: (old, next) => renameFile(app, old, next),
		writeAdapterFile: (path, content) => writeAdapterFile(app, path, content),
		deleteAdapterFile: (path) => deleteAdapterFile(app, path),

		// Editor ops
		openFile: (path) => openFile(app, path),
		closeFile: (path) => closeFile(app, path),
		typeIntoFile: (path, text, opts) => typeIntoFile(app, path, text, opts),
		replaceFileContent: (path, content) => replaceFileContent(app, path, content),
		runCommand: (id) => runCommand(app, id),

		// Wait
		waitForIdle: (ms) => waitForIdle(getKaos(), ms ?? DEFAULT_IDLE_TIMEOUT),
		waitForMemoryReceipt: (ms) => waitForMemoryReceipt(getKaos(), ms ?? DEFAULT_RECEIPT_TIMEOUT),
		waitForFile: (path, ms) => waitForFile(getKaos(), path, ms ?? DEFAULT_FILE_TIMEOUT),
		waitForCrdtFile: (path, ms) => waitForCrdtFile(getKaos(), path, ms),
		waitForDiskCrdtConverge: (path, ms) => waitForDiskCrdtConverge(getKaos(), path, ms),
		waitForActiveMarkdownLeaf: (path, ms) => waitForActiveMarkdownLeaf(app, getKaos(), path, ms),
		waitForCrdtBinding: (path, ms) => waitForCrdtBinding(getKaos(), path, ms),

		// Assertions
		assertFileExists: (path) => assertFileExists(app, path),
		assertFileNotExists: (path) => assertFileNotExists(app, path),
		assertFileHash: (path, hash) => assertFileHash(app, getKaos(), path, hash),
		assertDiskEqualsCrdt: (path) => assertDiskEqualsCrdt(getKaos(), path),
		assertNoConflictCopies: (dir) => assertNoConflictCopies(app, dir),

		// Manifests
		manifest: () => buildVaultManifest(app),
		async compareManifest(expected: VaultManifest): Promise<ManifestDiff> {
			const current = await buildVaultManifest(app);
			return diffManifests(expected, current);
		},

		// Flight trace
		async startTrace(recordingMode = "qa-safe", secret?: string): Promise<void> {
			await getKaos().startFlightTrace(recordingMode, secret);
		},
		async stopTrace(): Promise<void> {
			await getKaos().stopFlightTrace();
		},
		async exportTrace(exportPrivacy: "safe" | "full" = "safe"): Promise<string> {
			return getKaos().exportFlightTrace(exportPrivacy);
		},

		async analyzeTrace(tracePath: string, scenarioId?: string): Promise<unknown> {
			const raw = await app.vault.adapter.read(tracePath);
			return analyzeTrace(raw, { traceFile: tracePath, scenarioId });
		},

		async exportTraceWithAnalyzer(
			exportPrivacy: "safe" | "full" = "safe",
			scenarioId?: string,
		): Promise<{ tracePath: string; report: unknown }> {
			const tracePath = await getKaos().exportFlightTrace(exportPrivacy);
			const report = await api.analyzeTrace(tracePath, scenarioId);
			return { tracePath, report };
		},

		// Plugin state
		plugins() {
			const installedPlugins = (app as unknown as {
				plugins: { plugins: Record<string, { manifest: { version: string } }> };
			}).plugins.plugins;
			return Object.entries(installedPlugins).map(([id, p]) => ({
				id,
				version: p.manifest.version,
				enabled: true,
			}));
		},
	};
	qaConsoleApiDisposers.set(api, () => {
		const current = activeRun;
		if (!current) return;
		current.controller.abort(new Error("harness-unloaded"));
		current.coordinator?.dispose(new Error("harness-unloaded"));
	});

	return api;
}
