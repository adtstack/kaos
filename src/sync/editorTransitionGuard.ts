import type { TFile, TextFileView } from "obsidian";

export type EditorTransitionPhase =
	| "idle"
	| "source-settling"
	| "source-settled"
	| "target-loading"
	| "failed"
	| "inert";

export interface EditorSourceUnloadContext {
	readonly view: TextFileView;
	readonly sourceFile: TFile;
	readonly generation: number;
}

export interface EditorTargetLoadContext {
	readonly view: TextFileView;
	readonly targetFile: TFile;
	readonly generation: number;
}

export interface EditorTransitionGuardCallbacks {
	beforeSourceUnload(context: EditorSourceUnloadContext): Promise<void>;
	afterSourceUnload(context: EditorSourceUnloadContext): void;
	beforeTargetLoad(context: EditorTargetLoadContext): Promise<void>;
	afterTargetLoad(context: EditorTargetLoadContext): Promise<void>;
	onSaveSuppressed(input: Readonly<{
		phase: EditorTransitionPhase;
		file: TFile | null;
		clear: boolean | null;
	}>): void;
	onFailure(input: Readonly<{
		phase: EditorTransitionPhase;
		generation: number;
		error: unknown;
	}>): void;
}

export interface EditorTransitionGuardSnapshot {
	readonly phase: EditorTransitionPhase;
	readonly generation: number;
	readonly sourcePath: string | null;
	readonly targetPath: string | null;
	readonly inFlightSaveCount: number;
	readonly wrappersCurrent: boolean;
}

export interface EditorTransitionGuard {
	snapshot(): EditorTransitionGuardSnapshot;
	restore(): boolean;
}

export type EditorTransitionGuardInstallResult =
	| { kind: "installed"; guard: EditorTransitionGuard }
	| {
	kind: "unsupported";
	reason:
		| "method-not-wrappable"
		| "request-save-not-cancellable";
};

type RequestSaveFunction = TextFileView["requestSave"] & {
	cancel?: (...args: unknown[]) => unknown;
	flush?: (...args: unknown[]) => unknown;
	run?: (...args: unknown[]) => unknown;
};

type RuntimeMethod = (...args: never[]) => unknown;

interface OriginalDescriptor {
	readonly name: "onUnloadFile" | "onLoadFile" | "requestSave" | "save";
	readonly own: PropertyDescriptor | null;
}

const installedGuards = new WeakMap<object, EditorTransitionGuard>();

function rejectionError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function ownDescriptor(
	view: TextFileView,
	name: OriginalDescriptor["name"],
): OriginalDescriptor {
	return {
		name,
		own: Object.getOwnPropertyDescriptor(view, name) ?? null,
	};
}

function restoreDescriptor(view: TextFileView, descriptor: OriginalDescriptor): void {
	if (descriptor.own) {
		Object.defineProperty(view, descriptor.name, descriptor.own);
	} else {
		delete (view as unknown as Record<string, unknown>)[descriptor.name];
	}
}

function defineForwarder(
	wrapper: RequestSaveFunction,
	original: RequestSaveFunction,
	name: "cancel" | "flush" | "run",
	forward: (...args: unknown[]) => unknown,
): void {
	if (typeof original[name] !== "function") return;
	Object.defineProperty(wrapper, name, {
		configurable: true,
		enumerable: false,
		writable: false,
		value: forward,
	});
}

export function installEditorTransitionGuard(
	view: TextFileView,
	callbacks: EditorTransitionGuardCallbacks,
): EditorTransitionGuardInstallResult {
	const existing = installedGuards.get(view);
	if (existing) return { kind: "installed", guard: existing };

	const originalOnUnloadFile = Reflect.get(view, "onUnloadFile");
	const originalOnLoadFile = Reflect.get(view, "onLoadFile");
	const originalRequestSave = Reflect.get(view, "requestSave") as RequestSaveFunction;
	const originalSave = Reflect.get(view, "save");
	if (
		typeof originalOnUnloadFile !== "function"
		|| typeof originalOnLoadFile !== "function"
		|| typeof originalRequestSave !== "function"
		|| typeof originalSave !== "function"
	) {
		return { kind: "unsupported", reason: "method-not-wrappable" };
	}
	if (typeof originalRequestSave.cancel !== "function") {
		return { kind: "unsupported", reason: "request-save-not-cancellable" };
	}

	const originalDescriptors: OriginalDescriptor[] = [
		ownDescriptor(view, "onUnloadFile"),
		ownDescriptor(view, "onLoadFile"),
		ownDescriptor(view, "requestSave"),
		ownDescriptor(view, "save"),
	];

	let phase: EditorTransitionPhase = "idle";
	let generation = 0;
	let sourceEpoch = 0;
	let sourceFile: TFile | null = null;
	let targetFile: TFile | null = null;
	let targetRequestedForGeneration: number | null = null;
	let allowNativeSourceSave = false;
	let inert = false;
	const inFlightSaves = new Set<Promise<void>>();
	let loadTail: Promise<void> = Promise.resolve();

	const reportFailure = (
		failedPhase: EditorTransitionPhase,
		error: unknown,
		failedGeneration = generation,
	): void => {
		phase = "failed";
		callbacks.onFailure({ phase: failedPhase, generation: failedGeneration, error });
	};

	const trackSave = (promise: Promise<void>): Promise<void> => {
		inFlightSaves.add(promise);
		void promise.then(
			() => inFlightSaves.delete(promise),
			() => inFlightSaves.delete(promise),
		);
		return promise;
	};

	const suppressSave = (clear: boolean | null): Promise<void> => {
		callbacks.onSaveSuppressed({
			phase,
			file: view.file,
			clear,
		});
		return Promise.resolve();
	};

	const installedSave = function (
		this: TextFileView,
		clear?: boolean,
	): Promise<void> {
		if (this !== view) {
			return Promise.resolve(Reflect.apply(originalSave, this, [clear]));
		}
		const mayDelegate =
			phase === "idle"
			|| phase === "inert"
			|| (phase === "source-settling" && allowNativeSourceSave);
		if (!mayDelegate) return suppressSave(clear === true);
		let result: Promise<void>;
		try {
			result = Promise.resolve(Reflect.apply(originalSave, view, [clear]));
		} catch (error) {
			return Promise.reject(rejectionError(error));
		}
		return trackSave(result);
	};

	const installedRequestSave = function (this: TextFileView): void {
		if (this !== view) {
			Reflect.apply(originalRequestSave, this, []);
			return;
		}
		if (phase !== "idle" && phase !== "inert") {
			void suppressSave(null);
			return;
		}
		Reflect.apply(originalRequestSave, view, []);
	} as RequestSaveFunction;

	defineForwarder(installedRequestSave, originalRequestSave, "cancel", (...args) =>
		Reflect.apply(originalRequestSave.cancel!, originalRequestSave, args));
	defineForwarder(installedRequestSave, originalRequestSave, "flush", (...args) => {
		if (phase !== "idle" && phase !== "inert") {
			void suppressSave(null);
			return undefined;
		}
		return Reflect.apply(originalRequestSave.flush!, originalRequestSave, args);
	});
	defineForwarder(installedRequestSave, originalRequestSave, "run", (...args) => {
		if (phase !== "idle" && phase !== "inert") {
			void suppressSave(null);
			return undefined;
		}
		return Reflect.apply(originalRequestSave.run!, originalRequestSave, args);
	});

	const installedOnUnloadFile = function (
		this: TextFileView,
		file: TFile,
	): Promise<void> {
		if (this !== view || inert) {
			return Promise.resolve(Reflect.apply(originalOnUnloadFile, this, [file]));
		}

		generation += 1;
		const ownedGeneration = generation;
		sourceEpoch += 1;
		const ownedSourceEpoch = sourceEpoch;
		sourceFile = file;
		targetFile = null;
		targetRequestedForGeneration = null;
		phase = "source-settling";
		try {
			Reflect.apply(originalRequestSave.cancel!, originalRequestSave, []);
		} catch (error) {
			reportFailure("source-settling", error, ownedGeneration);
			return Promise.reject(rejectionError(error));
		}

		const preexistingSaves = Array.from(inFlightSaves);
		const context: EditorSourceUnloadContext = {
			view,
			sourceFile: file,
			generation: ownedGeneration,
		};
		const run = async (): Promise<void> => {
			try {
				await Promise.all(preexistingSaves);
				if (ownedSourceEpoch !== sourceEpoch) return;
				await callbacks.beforeSourceUnload(context);
				if (ownedSourceEpoch !== sourceEpoch) return;
				allowNativeSourceSave = true;
				try {
					await Promise.resolve(Reflect.apply(originalOnUnloadFile, view, [file]));
				} finally {
					allowNativeSourceSave = false;
				}
				if (ownedSourceEpoch !== sourceEpoch) return;
				callbacks.afterSourceUnload(context);
				phase = "source-settled";
			} catch (error) {
				allowNativeSourceSave = false;
				if (inert || ownedSourceEpoch !== sourceEpoch) return;
				reportFailure("source-settling", error, ownedGeneration);
				throw error;
			}
		};
		const task = loadTail.catch(() => undefined).then(run);
		loadTail = task.catch(() => undefined);
		return task;
	};

	const installedOnLoadFile = function (
		this: TextFileView,
		file: TFile,
	): Promise<void> {
		if (this !== view || inert) {
			return Promise.resolve(Reflect.apply(originalOnLoadFile, this, [file]));
		}

		let ownedGeneration: number;
		if (
			(phase === "source-settling" || phase === "source-settled")
			&& targetRequestedForGeneration === null
		) {
			ownedGeneration = generation;
		} else {
			generation += 1;
			ownedGeneration = generation;
		}
		targetRequestedForGeneration = ownedGeneration;
		targetFile = file;
		const context: EditorTargetLoadContext = {
			view,
			targetFile: file,
			generation: ownedGeneration,
		};
		const run = async (): Promise<void> => {
			if (ownedGeneration !== generation) return;
			phase = "target-loading";
			try {
				await callbacks.beforeTargetLoad(context);
				if (ownedGeneration !== generation) return;
				await Promise.resolve(Reflect.apply(originalOnLoadFile, view, [file]));
				if (ownedGeneration !== generation) return;
				await callbacks.afterTargetLoad(context);
				if (ownedGeneration !== generation) return;
				phase = "idle";
				sourceFile = null;
				targetFile = null;
				targetRequestedForGeneration = null;
			} catch (error) {
				if (inert || ownedGeneration !== generation) return;
				reportFailure("target-loading", error, ownedGeneration);
				throw error;
			}
		};
		const task = loadTail.catch(() => undefined).then(run);
		loadTail = task.catch(() => undefined);
		return task;
	};

	const wrappersCurrent = (): boolean =>
		view.onUnloadFile === installedOnUnloadFile
		&& view.onLoadFile === installedOnLoadFile
		&& view.requestSave === installedRequestSave
		&& view.save === installedSave;

	const guard: EditorTransitionGuard = {
		snapshot: () => ({
			phase,
			generation,
			sourcePath: sourceFile?.path ?? null,
			targetPath: targetFile?.path ?? null,
			inFlightSaveCount: inFlightSaves.size,
			wrappersCurrent: wrappersCurrent(),
		}),
		restore: () => {
			if (inert) return true;
			inert = true;
			phase = "inert";
			generation += 1;
			sourceEpoch += 1;
			allowNativeSourceSave = false;
			sourceFile = null;
			targetFile = null;
			targetRequestedForGeneration = null;
			let fullyOwned = true;
			for (const [name, installedMethod] of installedDescriptors) {
				if (Reflect.get(view, name) !== installedMethod) {
					fullyOwned = false;
					continue;
				}
				const descriptor = originalDescriptors.find((candidate) => candidate.name === name);
				if (descriptor) restoreDescriptor(view, descriptor);
			}
			installedGuards.delete(view);
			return fullyOwned;
		},
	};

	const installedDescriptors: Array<readonly [OriginalDescriptor["name"], RuntimeMethod]> = [
		["onUnloadFile", installedOnUnloadFile as RuntimeMethod],
		["onLoadFile", installedOnLoadFile as RuntimeMethod],
		["requestSave", installedRequestSave as RuntimeMethod],
		["save", installedSave as RuntimeMethod],
	];
	const installedNames: OriginalDescriptor["name"][] = [];
	try {
		for (const [name, method] of installedDescriptors) {
			Object.defineProperty(view, name, {
				configurable: true,
				enumerable: false,
				writable: true,
				value: method,
			});
			installedNames.push(name);
		}
	} catch {
		for (const name of installedNames.reverse()) {
			const descriptor = originalDescriptors.find((candidate) => candidate.name === name);
			if (descriptor) restoreDescriptor(view, descriptor);
		}
		return { kind: "unsupported", reason: "method-not-wrappable" };
	}

	installedGuards.set(view, guard);
	return { kind: "installed", guard };
}
