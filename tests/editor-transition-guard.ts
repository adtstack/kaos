import assert from "node:assert/strict";
import type { TFile, TextFileView } from "obsidian";
import {
	installEditorTransitionGuard,
	type EditorTransitionGuardCallbacks,
} from "../src/sync/editorTransitionGuard";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(count = 4): Promise<void> {
	for (let index = 0; index < count; index += 1) {
		await Promise.resolve();
	}
}

function file(path: string): TFile {
	return { path } as TFile;
}

type RequestSave = (() => void) & {
	cancel: () => void;
	flush: () => unknown;
	run: () => unknown;
};

interface FakeView extends TextFileView {
	file: TFile | null;
	data: string;
	requestSave: RequestSave;
	onUnloadFile(file: TFile): Promise<void>;
	onLoadFile(file: TFile): Promise<void>;
	save(clear?: boolean): Promise<void>;
}

function makeView(input: {
	file: TFile;
	onUnloadFile?: (this: FakeView, file: TFile) => Promise<void>;
	onLoadFile?: (this: FakeView, file: TFile) => Promise<void>;
	save?: (this: FakeView, clear?: boolean) => Promise<void>;
}): { view: FakeView; requestSaveCancelCount: () => number } {
	let cancelCount = 0;
	const requestSave = (() => undefined) as RequestSave;
	requestSave.cancel = () => { cancelCount += 1; };
	requestSave.flush = () => undefined;
	requestSave.run = () => undefined;
	const view = {
		file: input.file,
		data: `content:${input.file.path}`,
		requestSave,
		onUnloadFile: input.onUnloadFile ?? (async function () {}),
		onLoadFile: input.onLoadFile ?? (async function (targetFile) {
			this.file = targetFile;
			this.data = `content:${targetFile.path}`;
		}),
		save: input.save ?? (async function () {}),
	} as FakeView;
	return { view, requestSaveCancelCount: () => cancelCount };
}

function callbacks(overrides: Partial<EditorTransitionGuardCallbacks> = {}): EditorTransitionGuardCallbacks {
	return {
		beforeSourceUnload: async () => undefined,
		afterSourceUnload: () => undefined,
		beforeTargetLoad: async () => undefined,
		afterTargetLoad: async () => undefined,
		onSaveSuppressed: () => undefined,
		onFailure: () => undefined,
		...overrides,
	};
}

console.log("\n--- Editor transition guard: source settlement precedes native unload and target load ---");
{
	const fileA = file("A.md");
	const fileB = file("B.md");
	const oldSave = deferred<void>();
	const sourceSettlement = deferred<void>();
	const order: string[] = [];
	let saveCount = 0;
	const { view, requestSaveCancelCount } = makeView({
		file: fileA,
		save: async function (clear) {
			const index = saveCount++;
			order.push(`save:${index}:${clear === true ? "clear" : "ordinary"}:${this.file?.path}`);
			if (index === 0) await oldSave.promise;
		},
		onUnloadFile: async function (sourceFile) {
			order.push(`native-unload:${sourceFile.path}`);
			await this.save(true);
		},
		onLoadFile: async function (targetFile) {
			order.push(`native-load:${targetFile.path}`);
			this.file = targetFile;
			this.data = `content:${targetFile.path}`;
		},
	});
	const suppressed: string[] = [];
	const installed = installEditorTransitionGuard(view, callbacks({
		beforeSourceUnload: async ({ sourceFile }) => {
			order.push(`before-unload:${sourceFile.path}`);
			await sourceSettlement.promise;
		},
		afterSourceUnload: ({ sourceFile }) => order.push(`after-unload:${sourceFile.path}`),
		beforeTargetLoad: async ({ targetFile }) => order.push(`before-load:${targetFile.path}`),
		afterTargetLoad: async ({ targetFile }) => order.push(`after-load:${targetFile.path}`),
		onSaveSuppressed: ({ phase }) => suppressed.push(phase),
	}));
	assert.equal(installed.kind, "installed");
	if (installed.kind !== "installed") throw new Error("guard was not installed");

	const preexistingSave = view.save(false);
	const unload = view.onUnloadFile(fileA);
	await Promise.resolve();
	assert.deepEqual(order, ["save:0:ordinary:A.md"]);
	assert.equal(requestSaveCancelCount(), 1, "queued host save is cancelled at unload entry");

	oldSave.resolve();
	await preexistingSave;
	await flushMicrotasks();
	assert.deepEqual(order, ["save:0:ordinary:A.md", "before-unload:A.md"]);

	view.requestSave();
	await view.save(false);
	assert.equal(saveCount, 1, "new save entry is suppressed while source settlement is pending");
	assert.deepEqual(suppressed, ["source-settling", "source-settling"]);

	sourceSettlement.resolve();
	await unload;
	await view.onLoadFile(fileB);
	assert.deepEqual(order, [
		"save:0:ordinary:A.md",
		"before-unload:A.md",
		"native-unload:A.md",
		"save:1:clear:A.md",
		"after-unload:A.md",
		"before-load:B.md",
		"native-load:B.md",
		"after-load:B.md",
	]);
	assert.equal(installed.guard.snapshot().phase, "idle");
	assert.equal(view.file, fileB);
}

console.log("\n--- Editor transition guard: a newer target supersedes an older completion ---");
{
	const fileA = file("A.md");
	const fileB = file("B.md");
	const fileC = file("C.md");
	const bLoad = deferred<void>();
	const order: string[] = [];
	const { view } = makeView({
		file: fileA,
		onUnloadFile: async function () {},
		onLoadFile: async function (targetFile) {
			order.push(`native-load:${targetFile.path}`);
			if (targetFile === fileB) await bLoad.promise;
			this.file = targetFile;
		},
	});
	const installed = installEditorTransitionGuard(view, callbacks({
		beforeTargetLoad: async ({ targetFile }) => order.push(`before:${targetFile.path}`),
		afterTargetLoad: async ({ targetFile }) => order.push(`after:${targetFile.path}`),
	}));
	assert.equal(installed.kind, "installed");
	if (installed.kind !== "installed") throw new Error("guard was not installed");

	await view.onUnloadFile(fileA);
	const loadB = view.onLoadFile(fileB);
	await flushMicrotasks();
	const loadC = view.onLoadFile(fileC);
	bLoad.resolve();
	await Promise.all([loadB, loadC]);
	assert.deepEqual(order, [
		"before:B.md",
		"native-load:B.md",
		"before:C.md",
		"native-load:C.md",
		"after:C.md",
	]);
	assert.equal(view.file, fileC);
	assert.equal(installed.guard.snapshot().generation, 2);
}

console.log("\n--- Editor transition guard: queued targets never cancel source unload ---");
{
	const fileA = file("A.md");
	const fileB = file("B.md");
	const fileC = file("C.md");
	const sourceSettlement = deferred<void>();
	const order: string[] = [];
	const { view } = makeView({
		file: fileA,
		onUnloadFile: async function (sourceFile) {
			order.push(`native-unload:${sourceFile.path}`);
		},
		onLoadFile: async function (targetFile) {
			order.push(`native-load:${targetFile.path}`);
			this.file = targetFile;
		},
	});
	const installed = installEditorTransitionGuard(view, callbacks({
		beforeSourceUnload: async ({ sourceFile }) => {
			order.push(`before-unload:${sourceFile.path}`);
			await sourceSettlement.promise;
		},
		afterSourceUnload: ({ sourceFile }) => order.push(`after-unload:${sourceFile.path}`),
		beforeTargetLoad: async ({ targetFile }) => order.push(`before-load:${targetFile.path}`),
		afterTargetLoad: async ({ targetFile }) => order.push(`after-load:${targetFile.path}`),
	}));
	assert.equal(installed.kind, "installed");
	if (installed.kind !== "installed") throw new Error("guard was not installed");

	const unload = view.onUnloadFile(fileA);
	await flushMicrotasks();
	const loadB = view.onLoadFile(fileB);
	const loadC = view.onLoadFile(fileC);
	sourceSettlement.resolve();
	await Promise.all([unload, loadB, loadC]);
	assert.deepEqual(order, [
		"before-unload:A.md",
		"native-unload:A.md",
		"after-unload:A.md",
		"before-load:C.md",
		"native-load:C.md",
		"after-load:C.md",
	]);
	assert.equal(view.file, fileC);
}

console.log("\n--- Editor transition guard: unsupported requestSave is rejected without mutation ---");
{
	const fileA = file("A.md");
	const { view } = makeView({ file: fileA });
	delete (view.requestSave as Partial<RequestSave>).cancel;
	const originalUnload = view.onUnloadFile;
	const result = installEditorTransitionGuard(view, callbacks());
	assert.deepEqual(result, { kind: "unsupported", reason: "request-save-not-cancellable" });
	assert.equal(view.onUnloadFile, originalUnload);
}

console.log("\n--- Editor transition guard: restore only replaces wrappers it still owns ---");
{
	const fileA = file("A.md");
	const { view } = makeView({ file: fileA });
	const originals = {
		onUnloadFile: view.onUnloadFile,
		onLoadFile: view.onLoadFile,
		requestSave: view.requestSave,
		save: view.save,
	};
	const result = installEditorTransitionGuard(view, callbacks());
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") throw new Error("guard was not installed");
	assert.equal(result.guard.restore(), true);
	assert.equal(view.onUnloadFile, originals.onUnloadFile);
	assert.equal(view.onLoadFile, originals.onLoadFile);
	assert.equal(view.requestSave, originals.requestSave);
	assert.equal(view.save, originals.save);
}

console.log("\n--- Editor transition guard: restore invalidates pending work and preserves host replacements ---");
{
	const fileA = file("A.md");
	const sourceSettlement = deferred<void>();
	let nativeUnloadCount = 0;
	let failureCount = 0;
	const { view } = makeView({
		file: fileA,
		onUnloadFile: async function () {
			nativeUnloadCount += 1;
		},
	});
	const originals = {
		onUnloadFile: view.onUnloadFile,
		onLoadFile: view.onLoadFile,
		requestSave: view.requestSave,
	};
	const result = installEditorTransitionGuard(view, callbacks({
		beforeSourceUnload: async () => sourceSettlement.promise,
		onFailure: () => { failureCount += 1; },
	}));
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") throw new Error("guard was not installed");

	const pendingUnload = view.onUnloadFile(fileA);
	await flushMicrotasks();
	const hostSave = async function () {};
	view.save = hostSave;
	assert.equal(result.guard.restore(), false, "partial ownership is reported to the caller");
	assert.equal(view.onUnloadFile, originals.onUnloadFile, "an owned unload wrapper is restored");
	assert.equal(view.onLoadFile, originals.onLoadFile, "an owned load wrapper is restored");
	assert.equal(view.requestSave, originals.requestSave, "an owned debounce wrapper is restored");
	assert.equal(view.save, hostSave, "a host replacement is never overwritten");

	sourceSettlement.resolve();
	await pendingUnload;
	assert.equal(nativeUnloadCount, 0, "restoration invalidates a pending guarded unload");
	assert.equal(failureCount, 0, "invalidated work does not report a late transition failure");
}

console.log("\neditor-transition-guard: PASS");
