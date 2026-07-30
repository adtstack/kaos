import assert from "node:assert/strict";
import {
	createEditorHandoffExternalPhaseCoordinator,
} from "../qa/obsidian-harness/external-phase";
import { buildQaConsoleApi, disposeQaConsoleApi } from "../qa/obsidian-harness/api";
import type {
	QaConsoleApi,
	QaContext,
	QaExternalPhaseTicket,
	QaScenario,
} from "../qa/obsidian-harness/types";

async function waitUntil(
	predicate: () => boolean,
	timeoutMs = 1_000,
): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

console.log("\n--- QA external phase: exact one-shot resume ---");
{
	const controller = new AbortController();
	const coordinator = createEditorHandoffExternalPhaseCoordinator({
		runId: "run-a",
		scenarioId: "scenario-a",
		signal: controller.signal,
	});
	const resumed = coordinator.awaitExternalPhase("phase-a");
	const waiting = coordinator.getExternalPhaseTicket();
	assert.deepEqual(waiting, {
		runId: "run-a",
		sequence: 1,
		scenarioId: "scenario-a",
		name: "phase-a",
		state: "waiting",
	});
	assert.deepEqual(
		Object.keys(waiting ?? {}).sort(),
		["name", "runId", "scenarioId", "sequence", "state"],
		"phase tickets expose no body-like or arbitrary controller payload",
	);
	assert.equal(coordinator.resumeExternalPhase("older-run", 1), false);
	assert.equal(coordinator.resumeExternalPhase("run-a", 2), false);
	assert.equal(coordinator.resumeExternalPhase("run-a", 1), true);
	assert.deepEqual(await resumed, {
		runId: "run-a",
		sequence: 1,
		scenarioId: "scenario-a",
		name: "phase-a",
		state: "resumed",
	});
	assert.equal(coordinator.resumeExternalPhase("run-a", 1), false);
	assert.equal(coordinator.getExternalPhaseTicket(), null);
}

console.log("\n--- QA external phase: abort rejects and clears waiter ---");
{
	const controller = new AbortController();
	const coordinator = createEditorHandoffExternalPhaseCoordinator({
		runId: "run-abort",
		scenarioId: "scenario-abort",
		signal: controller.signal,
	});
	const waiting = coordinator.awaitExternalPhase("blocked");
	controller.abort(new Error("superseded"));
	await assert.rejects(waiting, /superseded/);
	assert.equal(coordinator.getExternalPhaseTicket(), null);
}

type FakeDebugApi = Readonly<{
	__qaOnlyEmitPhaseUnsafe(phase: string): Promise<void>;
}>;

function installHarnessWindow(log: string[]): void {
	const debug: FakeDebugApi = {
		async __qaOnlyEmitPhaseUnsafe(phase) {
			log.push(`phase:${phase}`);
		},
	};
	(globalThis as unknown as { window: Record<string, unknown> }).window = {
		__KAOS_DEBUG__: debug,
	};
}

function buildHarnessApi(
	scenarios: QaScenario[],
	log: string[],
): QaConsoleApi {
	installHarnessWindow(log);
	const app = {
		vault: {
			adapter: {
				read: async () => "",
			},
		},
	} as never;
	const api = buildQaConsoleApi(
		app,
		new Map(scenarios.map((scenario) => [scenario.id, scenario])),
	);
	api.startTrace = async () => { log.push("trace:start"); };
	api.stopTrace = async () => { log.push("trace:stop"); };
	api.exportTraceWithAnalyzer = async (_privacy, scenarioId) => {
		log.push(`trace:export:${scenarioId}`);
		return { tracePath: `${scenarioId}.ndjson`, report: { passed: true } };
	};
	return api;
}

function scenario(
	id: string,
	input: Partial<Pick<QaScenario, "setup" | "run" | "assert" | "cleanup">>,
): QaScenario {
	return {
		id,
		title: id,
		tags: [],
		setup: input.setup ?? (async () => {}),
		run: input.run ?? (async () => {}),
		assert: input.assert ?? (async () => {}),
		cleanup: input.cleanup,
	};
}

console.log("\n--- QA external phase: replacement run waits for full predecessor settlement ---");
{
	const log: string[] = [];
	let cleanupA = 0;
	const scenarioA = scenario("scenario-a", {
		setup: async () => { log.push("A:setup"); },
		run: async (ctx: QaContext) => {
			log.push("A:waiting");
			await ctx.awaitExternalPhase("hold-a");
			log.push("A:resumed");
		},
		cleanup: async () => {
			cleanupA += 1;
			log.push("A:cleanup");
		},
	});
	const scenarioB = scenario("scenario-b", {
		setup: async () => { log.push("B:setup"); },
		run: async () => { log.push("B:run"); },
		cleanup: async () => { log.push("B:cleanup"); },
	});
	const api = buildHarnessApi([scenarioA, scenarioB], log);
	const first = api.run("scenario-a", { timeoutMs: 1_000 });
	await waitUntil(() => api.getExternalPhaseTicket()?.name === "hold-a");
	const staleTicket = api.getExternalPhaseTicket() as QaExternalPhaseTicket;
	const second = api.run("scenario-b", { timeoutMs: 1_000 });
	const [firstResult, secondResult] = await Promise.all([first, second]);

	assert.equal(firstResult.passed, false);
	assert.equal(firstResult.errors.length, 1);
	assert.match(firstResult.errors[0] ?? "", /^aborted:/);
	assert.equal(secondResult.passed, true);
	assert.equal(cleanupA, 1, "superseded cleanup settles exactly once");
	assert.equal(api.resumeExternalPhase(staleTicket.runId, staleTicket.sequence), false);
	assert.equal(api.getExternalPhaseTicket(), null);
	const aExport = log.indexOf("trace:export:scenario-a");
	const aStop = log.indexOf("trace:stop", aExport);
	const aCleanup = log.indexOf("A:cleanup");
	const bStart = log.indexOf("trace:start", aCleanup + 1);
	const bSetup = log.indexOf("B:setup");
	assert(aExport >= 0 && aStop > aExport && aCleanup > aStop);
	assert(bStart > aCleanup && bSetup > bStart, "trace and cleanup lifecycles never overlap");
}

console.log("\n--- QA external phase: timeout rejects waiter and returns one categorical error ---");
{
	const log: string[] = [];
	let cleanupCount = 0;
	const timeoutScenario = scenario("timeout", {
		run: async (ctx: QaContext) => {
			await ctx.awaitExternalPhase("never-resumed");
		},
		cleanup: async () => {
			cleanupCount += 1;
		},
	});
	const api = buildHarnessApi([timeoutScenario], log);
	const result = await api.run("timeout", { timeoutMs: 20 });
	assert.equal(result.passed, false);
	assert.deepEqual(result.errors, ["timeout:20ms"]);
	assert.equal(cleanupCount, 1);
	assert.equal(api.getExternalPhaseTicket(), null);
	assert.equal(log.filter((entry) => entry === "trace:stop").length, 2);
}

console.log("\n--- QA external phase: timeout during trace start never enters setup ---");
{
	const log: string[] = [];
	let setupCalls = 0;
	const delayedTraceScenario = scenario("trace-start-timeout", {
		setup: async () => {
			setupCalls += 1;
		},
	});
	const api = buildHarnessApi([delayedTraceScenario], log);
	api.startTrace = async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
		log.push("trace:start:late");
	};
	const result = await api.run("trace-start-timeout", { timeoutMs: 20 });
	assert.deepEqual(result.errors, ["timeout:20ms"]);
	assert.equal(setupCalls, 0, "an expired run performs no scenario setup work");
}

console.log("\n--- QA external phase: harness unload rejects the active waiter ---");
{
	const log: string[] = [];
	const unloadScenario = scenario("unload", {
		run: async (ctx: QaContext) => {
			await ctx.awaitExternalPhase("waiting-for-unload");
		},
	});
	const api = buildHarnessApi([unloadScenario], log);
	const resultPromise = api.run("unload", { timeoutMs: 1_000 });
	await waitUntil(() => api.getExternalPhaseTicket()?.name === "waiting-for-unload");
	disposeQaConsoleApi(api);
	const result = await resultPromise;
	assert.deepEqual(result.errors, ["aborted:harness-unloaded"]);
	assert.equal(api.getExternalPhaseTicket(), null);
}

console.log("qa-external-phase-protocol: all tests passed");
