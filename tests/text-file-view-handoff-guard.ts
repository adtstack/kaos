import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { EditorSelection, Text, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TFile, TextFileView } from "obsidian";
import type {
	HostLoadCompletionReceipt,
	PendingHostLoadCandidate,
} from "../src/sync/editorHandoffState";
import {
	installTextFileViewHandoffGuard as installRawTextFileViewHandoffGuard,
	type ExactHostLoadDispatchIdentity,
	type ManagedHostSwitchTicket,
	type ManagedSaveOwnershipContext,
	type TextFileViewHandoffGuard,
	type TextFileViewHandoffGuardCallbacks,
	type TextFileViewHandoffGuardInstallOptions,
} from "../src/sync/textFileViewHandoffGuard";

function installTextFileViewHandoffGuard(
	view: TextFileView,
	callbacks: TextFileViewHandoffGuardCallbacks,
	options: TextFileViewHandoffGuardInstallOptions = { hostApiVersion: "1.13.4" },
) {
	return installRawTextFileViewHandoffGuard(view, callbacks, options);
}

type Deferred<T> = Readonly<{
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
}>;

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function fakeFile(path: string): TFile {
	return { path } as TFile;
}

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`Missing ${label}`);
	return value;
}

function clearLoadCapabilityOf(
	guard: TextFileViewHandoffGuard,
): "observable" | "clear-load-not-observable" {
	return guard.snapshot().clearLoadCapability;
}

type Host = TextFileView & {
	file: TFile | null;
	data: string;
	dirty: boolean;
	lastSavedData?: string | null;
	leaf?: Readonly<{ id: string }>;
};

type CallbackFacts = {
	loadEntries: TFile[];
	tickets: ManagedHostSwitchTicket[];
	setEntries: Array<Readonly<{
		ticket: ManagedHostSwitchTicket;
		incomingContent: string;
		clear: boolean;
	}>>;
	setExits: Array<Readonly<{
		ticket: ManagedHostSwitchTicket;
		hostLoadTokenId: string;
	}>>;
	suppressed: Array<Readonly<{
		sessionId: string;
		handoffGeneration: number;
		invocationFile: TFile | null;
		invocationPath: string | null;
	}>>;
	candidates: PendingHostLoadCandidate[];
	completions: HostLoadCompletionReceipt[];
	capabilityLosses: string[];
};

function callbacksFor(input?: Readonly<{
	sessionId?: string;
	generation?: () => number;
	onLoad?: (file: TFile) => void;
	onSet?: (ticket: ManagedHostSwitchTicket, content: string, clear: boolean) => void;
	onSetExit?: (ticket: ManagedHostSwitchTicket, hostLoadTokenId: string) => boolean;
	hostLoadToken?: (ticket: ManagedHostSwitchTicket, content: string) => string | null;
	saveOwnershipContext?: () => ManagedSaveOwnershipContext | null;
	isSaveOwnershipContextCurrent?: (context: ManagedSaveOwnershipContext) => boolean;
}>): Readonly<{ callbacks: TextFileViewHandoffGuardCallbacks; facts: CallbackFacts }> {
	const facts: CallbackFacts = {
		loadEntries: [],
		tickets: [],
		setEntries: [],
		setExits: [],
		suppressed: [],
		candidates: [],
		completions: [],
		capabilityLosses: [],
	};
	let switchIntentSeq = 0;
	const callbacks: TextFileViewHandoffGuardCallbacks = {
		onLoadFileEntry(targetFile, sourceUnloadReceiptId?: string) {
			facts.loadEntries.push(targetFile);
			input?.onLoad?.(targetFile);
			const ticket = {
				sessionId: input?.sessionId ?? "boot-a",
				handoffGeneration: input?.generation?.() ?? 1,
				switchIntentSeq: ++switchIntentSeq,
				targetFile,
				sourceUnloadReceiptId,
			} as ManagedHostSwitchTicket;
			facts.tickets.push(ticket);
			return ticket;
		},
		onSetViewDataEntry(entry) {
			facts.setEntries.push(entry);
			input?.onSet?.(entry.ticket, entry.incomingContent, entry.clear);
			return input?.hostLoadToken !== undefined
				? input.hostLoadToken(entry.ticket, entry.incomingContent)
				: `host-load:${entry.ticket.switchIntentSeq}`;
		},
		onSetViewDataExit(entry) {
			facts.setExits.push(entry);
			return input?.onSetExit?.(entry.ticket, entry.hostLoadTokenId) ?? true;
		},
		onHostLoadCandidate(candidate) {
			facts.candidates.push(candidate);
		},
		isHostLoadCandidateCurrent(candidate) {
			return facts.candidates.includes(candidate)
				&& callbacks.isSessionCurrent(candidate.sessionId, candidate.handoffGeneration);
		},
		onHostLoadCompleted(receipt) {
			facts.completions.push(receipt);
		},
		onSaveSuppressed(entry) {
			facts.suppressed.push(entry);
		},
		captureSaveOwnershipContext() {
			return input?.saveOwnershipContext?.() ?? null;
		},
		isSaveOwnershipContextCurrent(context) {
			return input?.isSaveOwnershipContextCurrent?.(context) ?? false;
		},
		onHostCapabilityLost(reason) {
			facts.capabilityLosses.push(reason);
		},
		isSessionCurrent(sessionId, handoffGeneration) {
			return sessionId === (input?.sessionId ?? "boot-a")
				&& handoffGeneration === (input?.generation?.() ?? 1);
		},
	};
	return { callbacks, facts };
}

function makeHostLoadCandidate(input: Readonly<{
	hostLoadTokenId: string;
	ticket: ManagedHostSwitchTicket;
	view: Host;
	incomingContent: string;
	runtimeViewDataBefore?: string;
	effectFingerprint?: string;
}>): PendingHostLoadCandidate {
	const startDocument = {
		kind: "start-document",
		toString: () => "content:A",
	} as unknown as Text;
	const targetDocument = {
		kind: "target-document",
		toString: () => input.incomingContent,
	} as unknown as Text;
	return {
		hostLoadTokenId: input.hostLoadTokenId,
		hostLoadCompletedEpoch: null,
		sourceUnloadReceiptId: input.ticket.sourceUnloadReceiptId,
		switchIntentSeq: input.ticket.switchIntentSeq,
		sessionId: input.ticket.sessionId,
		leafId: "leaf-a",
		handoffGeneration: input.ticket.handoffGeneration,
		targetPathAtDispatch: input.ticket.targetFile.path,
		cm: { kind: "cm", state: { doc: startDocument } } as unknown as EditorView,
		runtimeView: input.view,
		startDocument,
		targetDocument,
		incomingContent: input.incomingContent,
		applicationKind: "transaction",
		heldTransaction: { kind: "held-transaction", startState: { doc: startDocument }, newDoc: targetDocument } as unknown as Transaction,
		heldState: null,
		hostSetViewDataClear: true,
		nativeHistoryEpochBefore: 3,
		proposedSelection: { kind: "selection" } as unknown as EditorSelection,
		proposedScrollAnchor: 17,
		effectFingerprint: input.effectFingerprint ?? "effect:b",
		runtimeViewDataBefore: input.runtimeViewDataBefore ?? "content:A",
		bindingEpoch: 5,
		editorRevisionBefore: 0,
	};
}

function makeHostLoadReceipt(
	candidate: PendingHostLoadCandidate,
	overrides?: Partial<HostLoadCompletionReceipt>,
): HostLoadCompletionReceipt {
	return {
		receiptId: `receipt:${candidate.hostLoadTokenId}`,
		hostLoadTokenId: candidate.hostLoadTokenId,
		switchIntentSeq: candidate.switchIntentSeq,
		sessionId: candidate.sessionId,
		leafId: candidate.leafId,
		handoffGeneration: candidate.handoffGeneration,
		targetPath: candidate.targetPathAtDispatch,
		nativeHistoryEpoch: candidate.nativeHistoryEpochBefore + 1,
		historyResetObserved: true,
		targetSelection: candidate.proposedSelection,
		targetSelectionEpoch: 8,
		targetScrollAnchor: candidate.proposedScrollAnchor,
		targetScrollEpoch: 9,
		effectFingerprint: candidate.effectFingerprint,
		...overrides,
	};
}

function cancellable<T extends (...args: never[]) => unknown>(fn: T): T & { cancel(): void } {
	return Object.assign(fn, { cancel() {} });
}

function makeOwnHost(input?: Readonly<{
	file?: TFile | null;
	data?: string;
	onLoadFile?: (this: Host, file: TFile) => unknown;
	onUnloadFile?: (this: Host, file: TFile) => unknown;
	setViewData?: (this: Host, data: string, clear: boolean) => unknown;
	requestSave?: ((this: Host, ...args: unknown[]) => unknown) & { cancel?: () => void };
	save?: (this: Host, ...args: unknown[]) => unknown;
}>): Host {
	const host = {
		file: input?.file ?? fakeFile("A.md"),
		data: input?.data ?? "content:A",
		dirty: false,
		lastSavedData: input?.data ?? "content:A",
		leaf: { id: "leaf-a" },
		getViewData() {
			return this.data;
		},
		onLoadFile: input?.onLoadFile ?? (async function (this: Host, file: TFile) {
			this.file = file;
		}),
		onUnloadFile: input?.onUnloadFile ?? (async function (this: Host) {
			await this.save(true);
		}),
		setViewData: input?.setViewData ?? function (this: Host, data: string, _clear: boolean) {
			this.data = data;
		},
		requestSave: input?.requestSave ?? cancellable(function (this: Host) {
			this.dirty = true;
			return this;
		}),
		save: input?.save ?? (async function (this: Host, clear?: boolean) {
			const content = this.data;
			if (clear === true) {
				this.data = "";
				this.lastSavedData = null;
			}
			return content;
		}),
	};
	return host as unknown as Host;
}

async function retireSourceForNextLoad(host: Host): Promise<void> {
	const sourceFile = host.file;
	if (sourceFile === null) throw new Error("Expected a source file before host load");
	if (host.lastSavedData === undefined) host.lastSavedData = host.data;
	await host.onUnloadFile(sourceFile);
}

async function switchHostFile(host: Host, targetFile: TFile): Promise<void> {
	await retireSourceForNextLoad(host);
	await host.onLoadFile(targetFile);
}

async function exactHostLoadDispatchCertificateIsSynchronousAndExact(): Promise<void> {
	const fileA = fakeFile("A.md");
	const fileB = fakeFile("B.md");
	const observations: boolean[] = [];
	let guard: TextFileViewHandoffGuard | null = null;
	let identity: ExactHostLoadDispatchIdentity | null = null;
	const host = makeOwnHost({
		file: fileA,
		data: "content:A",
		onLoadFile: async function (targetFile) {
			this.file = targetFile;
			this.setViewData("content:B", true);
		},
		setViewData: function (data, _clear) {
			if (guard === null || identity === null) throw new Error("Missing dispatch certificate fixture");
			observations.push(guard.isExactHostLoadDispatchActive(identity));
			observations.push(guard.isExactHostLoadDispatchActive({
				...identity,
				incomingContent: `${identity.incomingContent}:lookalike`,
			}));
			this.data = data;
		},
	});
	const { callbacks, facts } = callbacksFor({
		hostLoadToken: () => "host-load:exact",
		onSet(ticket, incomingContent) {
			identity = Object.freeze({
				hostLoadTokenId: "host-load:exact",
				sessionId: ticket.sessionId,
				leafId: "leaf-a",
				handoffGeneration: ticket.handoffGeneration,
				switchIntentSeq: ticket.switchIntentSeq,
				sourceUnloadReceiptId: ticket.sourceUnloadReceiptId,
				targetPath: ticket.targetFile.path,
				targetFile: ticket.targetFile,
				runtimeView: host,
				incomingContent,
			});
		},
	});
	const result = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;
	guard = result.guard;
	await retireSourceForNextLoad(host);
	await host.onLoadFile(fileB);
	assert.equal(facts.setEntries.length, 1);
	assert.notEqual(identity, null);
	assert.deepEqual(observations, [true, false]);
	assert.equal(
		result.guard.isExactHostLoadDispatchActive(identity as ExactHostLoadDispatchIdentity),
		false,
		"the certificate expires before controller admission can run",
	);
}

function ownDescriptors(host: Host): ReadonlyMap<PropertyKey, PropertyDescriptor | undefined> {
	return new Map(
		["onLoadFile", "onUnloadFile", "setViewData", "requestSave", "save"].map((key) => [
			key,
			Object.getOwnPropertyDescriptor(host, key),
		]),
	);
}

function assertOwnDescriptorsEqual(
	host: Host,
	expected: ReadonlyMap<PropertyKey, PropertyDescriptor | undefined>,
): void {
	for (const [key, descriptor] of expected) {
		assert.deepEqual(Object.getOwnPropertyDescriptor(host, key), descriptor, `${String(key)} descriptor`);
	}
}

async function ownDescriptorRestoreAndMethodSemantics(): Promise<void> {
	const fileB = fakeFile("B.md");
	const rejected = new Error("save rejected");
	const setThrown = new Error("set threw");
	const callThis: unknown[] = [];
	const host = makeOwnHost({
		onLoadFile: async function (file, marker?: unknown) {
			callThis.push(this, marker);
			this.file = file;
			return "loaded";
		},
		setViewData: function (data, clear) {
			callThis.push(this, clear);
			if (data === "throw") throw setThrown;
			this.data = data;
			return "set";
		},
		requestSave: Object.assign(function (this: Host, marker?: unknown) {
			callThis.push(this, marker);
			return "requested";
		}, { cancel() {} }),
		save: async function (marker?: unknown) {
			callThis.push(this, marker);
			if (marker === "reject") throw rejected;
			return "saved";
		},
	});
	const originalSaveDescriptor = Object.getOwnPropertyDescriptor(host, "save");
	assert.notEqual(originalSaveDescriptor, undefined);
	Object.defineProperty(host, "save", {
		...originalSaveDescriptor,
		configurable: false,
		enumerable: false,
		writable: true,
	});
	const before = ownDescriptors(host);
	const { callbacks } = callbacksFor({
		saveOwnershipContext: () => {
			const file = host.file;
			return file === null ? null : {
				sessionId: "boot-a",
				generation: 1,
				file,
				path: file.path,
				displayedPath: file.path,
			};
		},
		isSaveOwnershipContextCurrent: (context) =>
			context.sessionId === "boot-a"
			&& context.generation === 1
			&& context.file === host.file
			&& context.path === host.file?.path
			&& context.displayedPath === host.file?.path,
	});
	const result = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;

	assert.equal(await Reflect.apply(host.onLoadFile, host, [fileB, "load-marker"]), "loaded");
	assert.equal(Reflect.apply(host.setViewData, host, ["content:B", true]), "set");
	assert.equal(Reflect.apply(host.requestSave, host, ["request-marker"]), undefined);
	(host.requestSave as unknown as { cancel(): void }).cancel();
	assert.equal(await Reflect.apply(host.save, host, ["save-marker"]), "saved");
	await assert.rejects(Reflect.apply(host.save, host, ["reject"]), (error: unknown) => error === rejected);
	assert.throws(
		() => Reflect.apply(host.setViewData, host, ["throw", false]),
		(error: unknown) => error === setThrown,
	);
	assert.equal(Reflect.apply(host.requestSave, host, ["throw"]), undefined);
	(host.requestSave as unknown as { cancel(): void }).cancel();
	assert.deepEqual(callThis.filter((value) => typeof value === "object"), [host, host, host, host, host]);

	result.guard.markInert();
	result.guard.restoreIfCurrent();
	assertOwnDescriptorsEqual(host, before);
}

async function inheritedRestoreAndPrototypeSafety(): Promise<void> {
	const prototype = {
		file: null as TFile | null,
		data: "",
		dirty: false,
		leaf: { id: "leaf-prototype" },
		getViewData(this: Host) { return this.data; },
		async onUnloadFile(this: Host) { return this.data; },
		async onLoadFile(this: Host, file: TFile) { this.file = file; },
		setViewData(this: Host, data: string, _clear: boolean) { this.data = data; },
		requestSave: cancellable(function (this: Host) { return this.data; }),
		async save(this: Host) { return this.data; },
	};
	const prototypeDescriptors = Object.getOwnPropertyDescriptors(prototype);
	const host = Object.create(prototype) as Host;
	host.file = fakeFile("A.md");
	host.data = "content:A";
	const result = installTextFileViewHandoffGuard(host, callbacksFor().callbacks);
	assert.equal(result.kind, "installed");
	for (const key of ["onLoadFile", "setViewData", "requestSave", "save"] as const) {
		assert.equal(Object.hasOwn(host, key), true, `${key} has an instance wrapper`);
	}
	assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), prototypeDescriptors);
	if (result.kind !== "installed") return;
	result.guard.markInert();
	result.guard.restoreIfCurrent();
	for (const key of ["onLoadFile", "setViewData", "requestSave", "save"] as const) {
		assert.equal(Object.hasOwn(host, key), false, `${key} inherited shadow removed`);
	}
	assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), prototypeDescriptors);
}

async function copiedWrappersStayBoundToManagedView(): Promise<void> {
	const fileA = fakeFile("A.md");
	const fileB = fakeFile("B.md");
	const otherFile = fakeFile("Other.md");
	const saveStarted = deferred<void>();
	const saveReleased = deferred<void>();
	const receivers: Host[] = [];
	const host = makeOwnHost({
		file: fileA,
		onLoadFile: async function (file) {
			receivers.push(this);
			this.file = file;
			this.setViewData("content:B", true);
		},
		setViewData: function (data, _clear) {
			receivers.push(this);
			this.data = data;
		},
		requestSave: Object.assign(function (this: Host) {
			receivers.push(this);
			return this;
		}, { cancel() {} }),
		save: async function (clear?: boolean) {
			receivers.push(this);
			if (clear === true) {
				this.data = "";
				this.lastSavedData = null;
				return;
			}
			saveStarted.resolve();
			await saveReleased.promise;
		},
	});
	const other = makeOwnHost({ file: otherFile, data: "content:other" });
	const callbackFacts = callbacksFor({
		saveOwnershipContext: () => {
			const file = host.file;
			return file === null ? null : {
				sessionId: "boot-a",
				generation: 1,
				file,
				path: file.path,
				displayedPath: file.path,
			};
		},
		isSaveOwnershipContextCurrent: (context) =>
			context.sessionId === "boot-a"
			&& context.generation === 1
			&& context.file === host.file
			&& context.path === host.file?.path
			&& context.displayedPath === host.file?.path,
	});
	const result = installTextFileViewHandoffGuard(host, callbackFacts.callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;
	const copiedLoad = host.onLoadFile;
	const copiedSet = host.setViewData;
	const copiedRequestSave = host.requestSave;
	const copiedSave = host.save;

	await retireSourceForNextLoad(host);
	receivers.length = 0;
	await Reflect.apply(copiedLoad, other, [fileB]);
	Reflect.apply(copiedSet, other, ["content:B", true]);
	assert.equal(Reflect.apply(copiedRequestSave, other, []), undefined);
	assert.notEqual(result.guard.snapshot().pendingOwnedSave, null);
	(host.requestSave as unknown as { cancel(): void }).cancel();
	const pendingSave = Reflect.apply(copiedSave, other, []);
	await saveStarted.promise;
	const inFlight = result.guard.snapshot().inFlight.values().next().value;
	assert.equal(inFlight?.file, fileB);
	assert.equal(inFlight?.path, "B.md");
	assert.equal(host.file, fileB);
	assert.equal(host.data, "content:B");
	assert.equal(other.file, otherFile, "copied load wrapper cannot relabel another leaf");
	assert.equal(other.data, "content:other", "copied set wrapper cannot mutate another leaf");
	assert.deepEqual(receivers, [host, host, host, host]);
	saveReleased.resolve();
	await pendingSave;
	result.guard.beginBlockingHandoff({
		handoffGeneration: 1,
		sourceLineagePath: "A.md",
		targetPath: "B.md",
	});
	host.file = fileA;
	Reflect.apply(copiedRequestSave, other, []);
	await Reflect.apply(copiedSave, other, []);
	assert.deepEqual(
		callbackFacts.facts.suppressed.map((entry) => entry.invocationPath),
		["A.md", "A.md"],
		"copied wrappers inspect only the managed view while blocking",
	);
}

async function ticketOrderingAndClearAssociation(): Promise<void> {
	const fileA = fakeFile("A.md");
	const fileB = fakeFile("B.md");
	const order: string[] = [];
	const host = makeOwnHost({
		file: fileA,
		onLoadFile: async function (file) {
			order.push("original-load");
			this.file = file;
			this.setViewData("content:B", false);
			this.setViewData("content:B", true);
		},
	});
	const { callbacks, facts } = callbacksFor({
		onLoad: () => order.push("load-entry"),
		onSet: () => order.push("set-entry"),
	});
	const first = installTextFileViewHandoffGuard(host, callbacks);
	const second = installTextFileViewHandoffGuard(host, callbacksFor({ sessionId: "replacement" }).callbacks);
	assert.equal(first.kind, "installed");
	assert.equal(second.kind, "installed");
	if (first.kind !== "installed" || second.kind !== "installed") return;
	assert.equal(second.guard, first.guard, "duplicate install returns the one guard");
	await switchHostFile(host, fileB);
	assert.deepEqual(order, ["load-entry", "original-load", "set-entry"]);
	assert.equal(facts.loadEntries[0], fileB);
	assert.equal(facts.setEntries.length, 1, "clear=false does not establish provenance");
	assert.equal(facts.setEntries[0]?.ticket.targetFile, fileB);
	assert.equal(facts.setEntries[0]?.incomingContent, "content:B");
}

async function candidateRoutesInsideOriginalClearBoundary(): Promise<void> {
	const fileB = fakeFile("B.md");
	let guard: TextFileViewHandoffGuard | null = null;
	let boundaryCandidate: PendingHostLoadCandidate | null = null;
	let boundaryResult: boolean | null = null;
	let exitCertificateActive: boolean | null = null;
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			this.file = file;
			this.setViewData("content:B", true);
		},
		setViewData: function (data, clear) {
			this.data = data;
			if (clear) {
				if (guard === null || boundaryCandidate === null) throw new Error("missing boundary route");
				boundaryResult = guard.reportHostLoadCandidate(boundaryCandidate);
			}
		},
	});
	const { callbacks, facts } = callbacksFor({
		onSet(ticket, content) {
			boundaryCandidate = makeHostLoadCandidate({
				hostLoadTokenId: `host-load:${ticket.switchIntentSeq}`,
				ticket,
				view: host,
				incomingContent: content,
			});
		},
		onSetExit(ticket, hostLoadTokenId) {
			if (guard === null || boundaryCandidate === null) return false;
			exitCertificateActive = guard.isExactHostLoadDispatchActive({
				hostLoadTokenId,
				sessionId: ticket.sessionId,
				leafId: boundaryCandidate.leafId,
				handoffGeneration: ticket.handoffGeneration,
				switchIntentSeq: ticket.switchIntentSeq,
				sourceUnloadReceiptId: ticket.sourceUnloadReceiptId,
				targetPath: ticket.targetFile.path,
				targetFile: ticket.targetFile,
				runtimeView: host,
				incomingContent: boundaryCandidate.incomingContent,
			});
			return exitCertificateActive;
		},
	});
	const result = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;
	guard = result.guard;
	await switchHostFile(host, fileB);
	assert.equal(boundaryResult, true, "association exists before original clear=true delegation");
	assert.equal(exitCertificateActive, true, "clear-load exit callback runs inside the exact synchronous dispatch certificate");
	assert.equal(facts.setExits.length, 1, "one synchronous candidate produces one clear-load exit certificate");
	assert.deepEqual(facts.candidates, [boundaryCandidate]);
	const receipt = makeHostLoadReceipt(
		required<PendingHostLoadCandidate>(facts.candidates[0], "boundary candidate"),
	);
	assert.equal(guard.reportHostLoadCompleted(receipt), true);
	assert.deepEqual(facts.completions, [receipt], "settled host invocation forwards completion immediately");
}

async function associatedHostLoadLifecycleRoutesExactFacts(): Promise<void> {
	const fileB = fakeFile("B.md");
	const setReached = deferred<void>();
	const loadReleased = deferred<void>();
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			this.file = file;
			this.setViewData("unassociated", false);
			this.setViewData("content:B", true);
			await loadReleased.promise;
		},
		setViewData: function (data, clear) {
			this.data = data;
			if (clear) setReached.resolve();
		},
	});
	const { callbacks, facts } = callbacksFor();
	const result = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;

	const unrelatedTicket: ManagedHostSwitchTicket = {
		sessionId: "boot-a",
		handoffGeneration: 1,
		switchIntentSeq: 99,
		targetFile: fileB,
		sourceUnloadReceiptId: "source-unload:unrelated",
	};
	const unassociated = makeHostLoadCandidate({
		hostLoadTokenId: "host-load:unassociated",
		ticket: unrelatedTicket,
		view: host,
		incomingContent: "unassociated",
	});
	assert.equal(result.guard.reportHostLoadCandidate(unassociated), false, "clear=false creates no route");

	await retireSourceForNextLoad(host);
	const pendingLoad = host.onLoadFile(fileB);
	await setReached.promise;
	const setEntry = required(facts.setEntries[0], "associated setViewData entry");
	const candidate = makeHostLoadCandidate({
		hostLoadTokenId: `host-load:${setEntry.ticket.switchIntentSeq}`,
		ticket: setEntry.ticket,
		view: host,
		incomingContent: setEntry.incomingContent,
	});
	const other = makeOwnHost({ file: fileB, data: "content:B" });
	const invalidCandidates: PendingHostLoadCandidate[] = [
		{ ...candidate, hostLoadTokenId: "host-load:wrong" },
		{ ...candidate, sessionId: "wrong-session" },
		{ ...candidate, handoffGeneration: candidate.handoffGeneration + 1 },
		{ ...candidate, switchIntentSeq: candidate.switchIntentSeq + 1 },
		{ ...candidate, sourceUnloadReceiptId: "source-unload:wrong" },
		{ ...candidate, targetPathAtDispatch: "wrong.md" },
		{ ...candidate, runtimeView: other },
		{ ...candidate, incomingContent: "wrong-content" },
		{ ...candidate, leafId: "wrong-leaf" },
	];
	for (const invalid of invalidCandidates) {
		assert.equal(result.guard.reportHostLoadCandidate(invalid), false);
	}
	assert.equal(result.guard.reportHostLoadCandidate(candidate), true);
	assert.equal(result.guard.reportHostLoadCandidate(candidate), false, "candidate route is one-shot");
	assert.deepEqual(facts.candidates, [candidate], "the real Task 4 fact is forwarded without synthesis");

	const wrongFingerprint = makeHostLoadReceipt(candidate, { effectFingerprint: "wrong-effect" });
	assert.equal(result.guard.reportHostLoadCompleted(wrongFingerprint), false);
	const receipt = makeHostLoadReceipt(candidate);
	assert.equal(result.guard.reportHostLoadCompleted(receipt), true);
	assert.equal(result.guard.reportHostLoadCompleted(receipt), false, "queued completion is one-shot");
	assert.deepEqual(facts.completions, [], "completion waits for original onLoadFile fulfillment");
	loadReleased.resolve();
	await pendingLoad;
	assert.deepEqual(facts.completions, [receipt]);
	assert.equal(result.guard.reportHostLoadCompleted(receipt), false, "completed receipt cannot replay");
}

async function rejectedHostLoadDiscardsQueuedCompletion(): Promise<void> {
	const fileB = fakeFile("B.md");
	const setReached = deferred<void>();
	const rejectLoad = deferred<void>();
	const hostError = new Error("host load rejected");
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			this.file = file;
			this.setViewData("content:B", true);
			await rejectLoad.promise;
			throw hostError;
		},
		setViewData: function (data, clear) {
			this.data = data;
			if (clear) setReached.resolve();
		},
	});
	const { callbacks, facts } = callbacksFor();
	const result = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;
	await retireSourceForNextLoad(host);
	const pendingLoad = host.onLoadFile(fileB);
	await setReached.promise;
	const setEntry = required(facts.setEntries[0], "rejected setViewData entry");
	const candidate = makeHostLoadCandidate({
		hostLoadTokenId: `host-load:${setEntry.ticket.switchIntentSeq}`,
		ticket: setEntry.ticket,
		view: host,
		incomingContent: setEntry.incomingContent,
	});
	const receipt = makeHostLoadReceipt(candidate);
	assert.equal(result.guard.reportHostLoadCandidate(candidate), true);
	assert.equal(result.guard.reportHostLoadCompleted(receipt), true);
	rejectLoad.resolve();
	await assert.rejects(pendingLoad, (error: unknown) => error === hostError);
	assert.deepEqual(facts.candidates, [candidate]);
	assert.deepEqual(facts.completions, [], "rejected host invocation discards queued completion");
	assert.equal(result.guard.reportHostLoadCompleted(receipt), false);
}

async function rejectedNoClearLoadAllowsMultipleCleanRetries(): Promise<void> {
	const fileB = fakeFile("B.md");
	const fileC = fakeFile("C.md");
	const fileD = fakeFile("D.md");
	const rejected = new Error("terminal rejected load");
	let generation = 1;
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			this.file = file;
			if (file === fileB) throw rejected;
			this.setViewData(`content:${file.path}`, true);
		},
	});
	const { callbacks, facts } = callbacksFor({ generation: () => generation });
	const result = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;

	await retireSourceForNextLoad(host);
	await assert.rejects(host.onLoadFile(fileB), (error: unknown) => error === rejected);
	for (const [nextGeneration, file] of [[2, fileC], [3, fileD]] as const) {
		generation = nextGeneration;
		await switchHostFile(host, file);
		const entry = required(facts.setEntries.at(-1), `${file.path} clean retry entry`);
		assert.equal(entry.ticket.targetFile, file);
		const candidate = makeHostLoadCandidate({
			hostLoadTokenId: `host-load:${entry.ticket.switchIntentSeq}`,
			ticket: entry.ticket,
			view: host,
			incomingContent: entry.incomingContent,
		});
		const receipt = makeHostLoadReceipt(candidate);
		assert.equal(result.guard.reportHostLoadCandidate(candidate), true);
		assert.equal(result.guard.reportHostLoadCompleted(receipt), true);
	}

	assert.deepEqual(facts.setEntries.map((entry) => entry.ticket.targetFile), [fileC, fileD]);
	assert.equal(clearLoadCapabilityOf(result.guard), "observable");
	assert.equal(facts.candidates.length, 2);
	assert.equal(facts.completions.length, 2);
}

async function fulfilledNoClearLoadLosesCapabilityUntilTeardown(): Promise<void> {
	const fileB = fakeFile("B.md");
	const fileC = fakeFile("C.md");
	const fileD = fakeFile("D.md");
	let generation = 1;
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			this.file = file;
			if (file !== fileB) this.setViewData(`content:${file.path}`, true);
		},
	});
	const firstFacts = callbacksFor({ generation: () => generation });
	const first = installTextFileViewHandoffGuard(host, firstFacts.callbacks);
	assert.equal(first.kind, "installed");
	if (first.kind !== "installed") return;

	await switchHostFile(host, fileB);
	const capabilityAfterB = clearLoadCapabilityOf(first.guard);
	generation = 2;
	await switchHostFile(host, fileC);
	first.guard.beginBlockingHandoff({
		handoffGeneration: 2,
		sourceLineagePath: "B.md",
		targetPath: "C.md",
	});
	const proofAfterLoss = first.guard.markTargetProven({
		handoffGeneration: 2,
		targetFile: fileC,
		certifiedContent: "content:C.md",
	});

	assert.equal(capabilityAfterB, "clear-load-not-observable");
	assert.equal(clearLoadCapabilityOf(first.guard), "clear-load-not-observable");
	assert.deepEqual(firstFacts.facts.loadEntries, [fileB], "capability loss stops future managed entries");
	assert.deepEqual(firstFacts.facts.setEntries, []);
	assert.equal(proofAfterLoss, false);
	assert.equal(host.data, "content:C.md", "host pass-through remains functional after capability loss");

	first.guard.restoreIfCurrent();
	const resetFacts = callbacksFor({ sessionId: "boot-reset" });
	const reset = installTextFileViewHandoffGuard(host, resetFacts.callbacks);
	assert.equal(reset.kind, "installed");
	if (reset.kind !== "installed") return;
	await switchHostFile(host, fileD);
	assert.equal(clearLoadCapabilityOf(reset.guard), "observable", "teardown creates a fresh capability epoch");
	assert.deepEqual(resetFacts.facts.loadEntries, [fileD]);
	assert.equal(resetFacts.facts.setEntries.length, 1);
}

async function unretiredOverlappingLoadsRemainAuthorityInert(): Promise<void> {
	const fileB = fakeFile("B.md");
	const fileC = fakeFile("C.md");
	const fileD = fakeFile("D.md");
	const bEntered = deferred<void>();
	const cEntered = deferred<void>();
	const releaseB = deferred<void>();
	const releaseC = deferred<void>();
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			this.file = file;
			if (file === fileB) {
				bEntered.resolve();
				await releaseB.promise;
				return;
			}
			if (file === fileC) {
				cEntered.resolve();
				await releaseC.promise;
			}
			this.setViewData(`content:${file.path}`, true);
		},
	});
	const { callbacks, facts } = callbacksFor();
	const result = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;

	const pendingB = host.onLoadFile(fileB);
	await bEntered.promise;
	const pendingC = host.onLoadFile(fileC);
	await cEntered.promise;
	releaseB.resolve();
	await pendingB;
	releaseC.resolve();
	await pendingC;
	await switchHostFile(host, fileD);

	assert.equal(clearLoadCapabilityOf(result.guard), "observable");
	assert.deepEqual(
		facts.loadEntries,
		[fileD],
		"unretired overlaps stay inert while a later retired load remains provable",
	);
	assert.equal(facts.setEntries.length, 1);
	assert.equal(host.data, "content:D.md");
}

async function staleLoadBecomesCallbackInert(): Promise<void> {
	const fileB = fakeFile("B.md");
	const fileC = fakeFile("C.md");
	const releaseB = deferred<void>();
	let generation = 1;
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			this.file = file;
			this.setViewData(`content:${file.path}`, true);
			if (file === fileB) await releaseB.promise;
		},
	});
	const { callbacks, facts } = callbacksFor({ generation: () => generation });
	const result = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;
	await retireSourceForNextLoad(host);
	const pendingB = host.onLoadFile(fileB);
	generation = 2;
	await host.onLoadFile(fileC);
	const bEntry = required(facts.setEntries[0], "stale B setViewData entry");
	const staleB = makeHostLoadCandidate({
		hostLoadTokenId: `host-load:${bEntry.ticket.switchIntentSeq}`,
		ticket: bEntry.ticket,
		view: host,
		incomingContent: bEntry.incomingContent,
	});
	assert.equal(result.guard.reportHostLoadCandidate(staleB), false);
	assert.deepEqual(facts.candidates, [], "B cannot report after C owns the generation");
	releaseB.resolve();
	await pendingB;
	assert.equal(facts.setEntries.length, 1, "overlapping C is fail-closed even after B emitted a clear");
	assert.equal(facts.setEntries[0]?.ticket.targetFile, fileB);
	assert.equal(host.data, "content:C.md");
}

async function overlappingLoadsFailClosed(input: Readonly<{
	label: string;
	advanceGeneration: boolean;
}>): Promise<void> {
	const fileA = fakeFile("A.md");
	const fileB = fakeFile("B.md");
	const fileC = fakeFile("C.md");
	const fileD = fakeFile("D.md");
	const bEntered = deferred<void>();
	const cEntered = deferred<void>();
	const releaseB = deferred<void>();
	const releaseC = deferred<void>();
	let generation = 1;
	const host = makeOwnHost({
		file: fileA,
		onLoadFile: async function (file) {
			if (file === fileB) {
				this.file = fileB;
				bEntered.resolve();
				await releaseB.promise;
				this.setViewData("content:B", true);
				return;
			}
			if (file === fileC) {
				this.file = fileC;
				cEntered.resolve();
				await releaseC.promise;
				this.setViewData("content:C", true);
				return;
			}
			this.file = file;
			this.setViewData("content:D", true);
		},
	});
	const { callbacks, facts } = callbacksFor({ generation: () => generation });
	const result = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;

	await retireSourceForNextLoad(host);
	const pendingB = host.onLoadFile(fileB);
	await bEntered.promise;
	if (input.advanceGeneration) generation = 2;
	await retireSourceForNextLoad(host);
	const pendingC = host.onLoadFile(fileC);
	await cEntered.promise;
	releaseB.resolve();
	await pendingB;

	const cTicket = required(facts.tickets[1], `${input.label} C ticket`);
	const crossCandidate = makeHostLoadCandidate({
		hostLoadTokenId: `host-load:${cTicket.switchIntentSeq}`,
		ticket: cTicket,
		view: host,
		incomingContent: "content:B",
	});
	const crossCandidateResult = result.guard.reportHostLoadCandidate(crossCandidate);
	const crossReceiptResult = result.guard.reportHostLoadCompleted(
		makeHostLoadReceipt(crossCandidate),
	);
	releaseC.resolve();
	await pendingC;

	assert.deepEqual(
		[crossCandidateResult, crossReceiptResult],
		[false, false],
		`${input.label}: B clear-load facts cannot route under C's ticket`,
	);
	assert.equal(facts.setEntries.length, 0, `${input.label}: all overlapping clear loads are ambiguous`);
	assert.deepEqual(facts.candidates, []);
	assert.deepEqual(facts.completions, []);

	if (input.advanceGeneration) generation = 3;
	await switchHostFile(host, fileD);
	const dEntry = required(facts.setEntries[0], `${input.label} clean D entry`);
	assert.equal(dEntry.ticket.targetFile, fileD, `${input.label}: a later non-overlap retry is certifiable`);
	const dCandidate = makeHostLoadCandidate({
		hostLoadTokenId: `host-load:${dEntry.ticket.switchIntentSeq}`,
		ticket: dEntry.ticket,
		view: host,
		incomingContent: dEntry.incomingContent,
	});
	const dReceipt = makeHostLoadReceipt(dCandidate);
	assert.equal(result.guard.reportHostLoadCandidate(dCandidate), true);
	assert.equal(result.guard.reportHostLoadCompleted(dReceipt), true);
	assert.deepEqual(facts.candidates, [dCandidate]);
	assert.deepEqual(facts.completions, [dReceipt]);
}

async function delayedClearAfterSettlementPoisonsTheConcurrentRetryOnly(): Promise<void> {
	const fileB = fakeFile("B.md");
	const fileC = fakeFile("C.md");
	const fileD = fakeFile("D.md");
	const bEntered = deferred<void>();
	const cEntered = deferred<void>();
	const releaseB = deferred<void>();
	const releaseC = deferred<void>();
	let generation = 1;
	let fireDelayedB = (): void => {
		throw new Error("delayed B clear was not scheduled");
	};
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			if (file === fileB) {
				this.file = fileB;
				fireDelayedB = () => this.setViewData("content:B-delayed", true);
				bEntered.resolve();
				await releaseB.promise;
				return;
			}
			if (file === fileC) {
				this.file = fileC;
				cEntered.resolve();
				await releaseC.promise;
				this.setViewData("content:C", true);
				return;
			}
			this.file = fileD;
			this.setViewData("content:D", true);
		},
	});
	const { callbacks, facts } = callbacksFor({ generation: () => generation });
	const result = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;

	await retireSourceForNextLoad(host);
	const pendingB = host.onLoadFile(fileB);
	await bEntered.promise;
	assert.equal(facts.setEntries.length, 0);
	generation = 2;
	await retireSourceForNextLoad(host);
	const pendingC = host.onLoadFile(fileC);
	await cEntered.promise;
	releaseB.resolve();
	await pendingB;
	fireDelayedB();
	const cTicket = required(facts.tickets[1], "delayed-clear C ticket");
	const crossCandidate = makeHostLoadCandidate({
		hostLoadTokenId: `host-load:${cTicket.switchIntentSeq}`,
		ticket: cTicket,
		view: host,
		incomingContent: "content:B-delayed",
	});
	const crossCandidateResult = result.guard.reportHostLoadCandidate(crossCandidate);
	const crossReceiptResult = result.guard.reportHostLoadCompleted(
		makeHostLoadReceipt(crossCandidate),
	);
	releaseC.resolve();
	await pendingC;

	assert.deepEqual(
		[crossCandidateResult, crossReceiptResult],
		[false, false],
		"a post-settlement B clear cannot become C's sole current invocation",
	);
	assert.equal(facts.setEntries.length, 0, "the concurrent C retry remains ambiguity-inert");
	assert.deepEqual(facts.candidates, []);
	assert.deepEqual(facts.completions, []);

	generation = 3;
	await switchHostFile(host, fileD);
	const dEntry = required(facts.setEntries[0], "post-ambiguity D entry");
	const dCandidate = makeHostLoadCandidate({
		hostLoadTokenId: `host-load:${dEntry.ticket.switchIntentSeq}`,
		ticket: dEntry.ticket,
		view: host,
		incomingContent: dEntry.incomingContent,
	});
	const dReceipt = makeHostLoadReceipt(dCandidate);
	assert.equal(result.guard.reportHostLoadCandidate(dCandidate), true);
	assert.equal(result.guard.reportHostLoadCompleted(dReceipt), true);
	assert.deepEqual(facts.candidates, [dCandidate]);
	assert.deepEqual(facts.completions, [dReceipt]);
}

async function loadEntryPathIsImmutableAcrossTFileRename(): Promise<void> {
	const fileB = fakeFile("B.md");
	const setReached = deferred<void>();
	const releaseLoad = deferred<void>();
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			this.file = file;
			this.setViewData("content:B", true);
			await releaseLoad.promise;
		},
		setViewData: function (data, clear) {
			this.data = data;
			if (clear) setReached.resolve();
		},
	});
	const { callbacks, facts } = callbacksFor();
	const result = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;

	await retireSourceForNextLoad(host);
	const pendingLoad = host.onLoadFile(fileB);
	await setReached.promise;
	const entry = required(facts.setEntries[0], "pre-rename host-load entry");
	(fileB as { path: string }).path = "Renamed.md";
	const renamedCandidate: PendingHostLoadCandidate = {
		...makeHostLoadCandidate({
			hostLoadTokenId: `host-load:${entry.ticket.switchIntentSeq}`,
			ticket: entry.ticket,
			view: host,
			incomingContent: entry.incomingContent,
		}),
		targetPathAtDispatch: "Renamed.md",
	};
	const renamedCandidateResult = result.guard.reportHostLoadCandidate(renamedCandidate);
	const renamedReceiptResult = result.guard.reportHostLoadCompleted(
		makeHostLoadReceipt(renamedCandidate),
	);
	result.guard.beginBlockingHandoff({
		handoffGeneration: 1,
		sourceLineagePath: "A.md",
		targetPath: "Renamed.md",
	});
	const renamedProofResult = result.guard.markTargetProven({
		handoffGeneration: 1,
		targetFile: fileB,
		certifiedContent: "content:B",
	});
	result.guard.beginBlockingHandoff({
		handoffGeneration: 1,
		sourceLineagePath: "A.md",
		targetPath: "B.md",
	});
	const originalPathProofResult = result.guard.markTargetProven({
		handoffGeneration: 1,
		targetFile: fileB,
		certifiedContent: "content:B",
	});
	releaseLoad.resolve();
	await pendingLoad;

	assert.deepEqual(
		[renamedCandidateResult, renamedReceiptResult, renamedProofResult, originalPathProofResult],
		[false, false, false, false],
		"a mutable TFile cannot relabel entry-bounded candidate, receipt, or proof authority",
	);
	assert.deepEqual(facts.candidates, []);
	assert.deepEqual(facts.completions, []);
}

async function callbackCanBlockBeforeTicketReturn(): Promise<void> {
	const fileB = fakeFile("B.md");
	let cancelCount = 0;
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			this.file = file;
			this.setViewData("content:B", true);
		},
		requestSave: Object.assign(function () {}, {
			cancel() { cancelCount += 1; },
		}),
	});
	let guardRef: ReturnType<typeof installTextFileViewHandoffGuard> | null = null;
	const { callbacks } = callbacksFor({
		onLoad() {
			if (guardRef?.kind !== "installed") throw new Error("guard not installed");
			guardRef.guard.beginBlockingHandoff({
				handoffGeneration: 1,
				sourceLineagePath: "A.md",
				targetPath: "B.md",
			});
		},
	});
	guardRef = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(guardRef.kind, "installed");
	await switchHostFile(host, fileB);
	assert.equal(cancelCount, 2, "unload and synchronous handoff each cancel once");
	host.data = "content:B";
	assert.equal(
		guardRef.kind === "installed" && guardRef.guard.markTargetProven({
			handoffGeneration: 1,
			targetFile: fileB,
			certifiedContent: "content:B",
		}),
		true,
		"the exact ticket returned after synchronous handoff entry attaches to blocking mode",
	);
}

async function saveCancellationSuppressionProofAndPinning(): Promise<void> {
	const fileA = fakeFile("A.md");
	const fileB = fakeFile("B.md");
	const fileC = fakeFile("C.md");
	const wrongPathFile = fakeFile("wrong.md");
	const samePathDifferentFile = fakeFile("B.md");
	let cancelCount = 0;
	let requestCount = 0;
	let requestRunCount = 0;
	let saveCount = 0;
	let generation = 1;
	const saveStarted = deferred<void>();
	const saveReleased = deferred<void>();
	const host = makeOwnHost({
		file: fileA,
		data: "content:A",
		onLoadFile: async function (file) {
			this.file = file;
			this.setViewData(`content:${file.path}`, true);
		},
		requestSave: Object.assign(function (this: Host) {
			requestCount += 1;
			return this;
		}, {
			cancel() { cancelCount += 1; },
			run() { requestRunCount += 1; },
		}),
		save: async function (clear?: boolean) {
			saveCount += 1;
			if (clear === true) {
				this.data = "";
				this.lastSavedData = null;
			}
			saveStarted.resolve();
			await saveReleased.promise;
			return this.data;
		},
	});
	const { callbacks, facts } = callbacksFor({
		generation: () => generation,
		saveOwnershipContext: () => {
			const file = host.file;
			return file === null ? null : {
				sessionId: "boot-a",
				generation,
				file,
				path: file.path,
				displayedPath: file.path,
			};
		},
		isSaveOwnershipContextCurrent: (context) =>
			context.sessionId === "boot-a"
			&& context.generation === generation
			&& context.file === host.file
			&& context.path === host.file?.path
			&& context.displayedPath === host.file?.path,
	});
	const result = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;
	(host.requestSave as unknown as { cancel(): void }).cancel();
	assert.equal(cancelCount, 1, "installed debouncer retains its public cancel capability");

	const pending = host.save();
	await saveStarted.promise;
	const firstSnapshot = result.guard.snapshot();
	const firstInFlight = firstSnapshot.inFlight.values().next().value;
	assert.equal(firstInFlight?.file, fileA);
	assert.equal(firstInFlight?.path, "A.md");
	assert.equal(typeof firstInFlight?.startedAt, "number");
	host.file = fileB;
	const secondSnapshot = result.guard.snapshot();
	assert.equal(secondSnapshot.inFlight.values().next().value?.file, fileA, "entry identity stays pinned");
	saveReleased.resolve();
	await pending;
	assert.equal(result.guard.snapshot().inFlight.size, 0);

	host.file = fileA;
	host.data = "content:A";
	host.lastSavedData = "content:A";
	await switchHostFile(host, fileB);
	result.guard.beginBlockingHandoff({
		handoffGeneration: 1,
		sourceLineagePath: "A.md",
		targetPath: "B.md",
	});
	assert.equal(cancelCount, 3, "cancel, unload, and handoff each cancel synchronously");
	host.file = fileA;
	assert.equal(host.requestSave(), undefined);
	assert.equal(await host.save(), undefined);
	host.file = null;
	host.requestSave();
	await host.save();
	host.file = fileB;
	host.data = "content:B";
	host.requestSave();
	await host.save();
	assert.equal((host.requestSave as unknown as { run(): unknown }).run(), undefined);
	generation = 2;
	host.file = fileC;
	host.requestSave();
	await host.save();
	assert.equal(requestCount, 0);
	assert.equal(requestRunCount, 0, "forced debouncer run is also suppressed while blocking");
	assert.equal(saveCount, 2, "only the held save and forced source retirement delegated");
	assert.equal(facts.suppressed.length, 7, "superseded generations suppress without stale callbacks");
	assert.deepEqual(facts.suppressed.slice(0, 2).map((entry) => entry.invocationPath), ["A.md", "A.md"]);
	assert.deepEqual(facts.suppressed.slice(2, 4).map((entry) => entry.invocationPath), [null, null]);

	assert.equal(result.guard.markTargetProven({
		handoffGeneration: 2,
		targetFile: fileB,
		certifiedContent: "content:B",
	}), false, "wrong generation cannot prove");
	generation = 1;
	host.file = fileB;
	assert.equal(result.guard.markTargetProven({
		handoffGeneration: 1,
		targetFile: wrongPathFile,
		certifiedContent: "content:B",
	}), false, "wrong TFile and path cannot prove");
	assert.equal(result.guard.markTargetProven({
		handoffGeneration: 1,
		targetFile: samePathDifferentFile,
		certifiedContent: "content:B",
	}), false, "path-only identity cannot prove");
	(fileB as { path: string }).path = "changed-after-ticket.md";
	assert.equal(result.guard.markTargetProven({
		handoffGeneration: 1,
		targetFile: fileB,
		certifiedContent: "content:B",
	}), false, "the exact target object with a changed path cannot prove");
	(fileB as { path: string }).path = "B.md";
	assert.equal(result.guard.markTargetProven({
		handoffGeneration: 1,
		targetFile: fileB,
		certifiedContent: "different",
	}), false, "certified-content mismatch cannot prove");
	host.getViewData = () => "editor-mismatch";
	assert.equal(result.guard.markTargetProven({
		handoffGeneration: 1,
		targetFile: fileB,
		certifiedContent: "content:B",
	}), false, "editor mismatch cannot prove even when the runtime cache matches");
	host.getViewData = () => "content:B";
	host.data = "cache-mismatch";
	assert.equal(result.guard.markTargetProven({
		handoffGeneration: 1,
		targetFile: fileB,
		certifiedContent: "content:B",
	}), false, "runtime cache mismatch cannot prove even when editor data matches");
	host.data = "content:B";
	host.getViewData = () => {
		result.guard.beginBlockingHandoff({
			handoffGeneration: 1,
			sourceLineagePath: "B.md",
			targetPath: "C.md",
		});
		return "content:B";
	};
	assert.equal(result.guard.markTargetProven({
		handoffGeneration: 1,
		targetFile: fileB,
		certifiedContent: "content:B",
	}), false, "host read reentry cannot release a superseding handoff gate");
	assert.equal(
		result.guard.snapshot().mode.kind === "blocking-handoff"
			? result.guard.snapshot().mode.targetPath
			: null,
		"C.md",
		"the superseding handoff remains blocking after stale B proof returns",
	);
	result.guard.beginBlockingHandoff({
		handoffGeneration: 1,
		sourceLineagePath: "A.md",
		targetPath: "B.md",
	});
	host.getViewData = () => "content:B";
	assert.equal(result.guard.markTargetProven({
		handoffGeneration: 1,
		targetFile: fileB,
		certifiedContent: "content:B",
	}), true);
	assert.equal(facts.suppressed.length, 7, "suppressed saves are never replayed");
	assert.equal(
		result.guard.snapshot().hostCapabilityState,
		"ready",
		`post-proof host capability lost: ${facts.capabilityLosses.join(",")}`,
	);
	assert.equal(host.requestSave(), undefined);
	assert.notEqual(result.guard.snapshot().pendingOwnedSave, null);
	await (host.requestSave as unknown as { run(): Promise<void> }).run();
	assert.equal(requestCount, 0);
	assert.equal(requestRunCount, 0);
	assert.equal(await host.save(), "content:B");
	assert.equal(saveCount, 4, "owned flush and a fresh direct save delegate only after proof");
}

async function thirdPartyAndInertSafety(): Promise<void> {
	const fileB = fakeFile("B.md");
	const fileC = fakeFile("C.md");
	let originalLoads = 0;
	let originalRequestSaves = 0;
	let originalRequestRuns = 0;
	let originalRequestFlushes = 0;
	let thirdPartyLoads = 0;
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			originalLoads += 1;
			this.file = file;
		},
		requestSave: Object.assign(function (this: Host) {
			originalRequestSaves += 1;
			this.dirty = true;
		}, {
			cancel() {},
			run() { originalRequestRuns += 1; },
			flush() { originalRequestFlushes += 1; },
		}),
	});
	const { callbacks, facts } = callbacksFor();
	const result = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;
	const capturedKaosWrapper = host.onLoadFile;
	const capturedSetViewData = host.setViewData;
	const capturedRequestSave = host.requestSave;
	const capturedSave = host.save;
	const thirdParty = async function (this: Host, file: TFile): Promise<void> {
		thirdPartyLoads += 1;
		await Reflect.apply(capturedKaosWrapper, this, [file]);
	};
	host.onLoadFile = thirdParty;
	result.guard.markInert();
	result.guard.beginBlockingHandoff({
		handoffGeneration: 99,
		sourceLineagePath: "A.md",
		targetPath: "B.md",
	});
	result.guard.restoreIfCurrent();
	assert.equal(host.onLoadFile, thirdParty, "later wrapper is preserved");
	await host.onLoadFile(fileB);
	Reflect.apply(capturedSetViewData, host, ["inert-content", true]);
	Reflect.apply(capturedRequestSave, host, []);
	await Reflect.apply(
		(capturedRequestSave as unknown as { flush(): unknown }).flush,
		capturedRequestSave,
		[],
	);
	Reflect.apply(
		(capturedRequestSave as unknown as { run(): unknown }).run,
		capturedRequestSave,
		[],
	);
	await Reflect.apply(capturedSave, host, []);
	assert.equal(thirdPartyLoads, 1);
	assert.equal(originalLoads, 1);
	assert.deepEqual(
		[originalRequestSaves, originalRequestRuns, originalRequestFlushes],
		[1, 1, 1],
		"captured inert request methods pass through to the original scheduler",
	);
	assert.equal(facts.loadEntries.length, 0, "captured inert wrapper retains no KAOS callbacks");
	assert.equal(facts.setEntries.length, 0);
	assert.equal(facts.suppressed.length, 0);
	const replacementFacts = callbacksFor({ sessionId: "boot-reinstalled" });
	const reinstalled = installTextFileViewHandoffGuard(host, replacementFacts.callbacks);
	assert.equal(reinstalled.kind, "installed");
	if (reinstalled.kind !== "installed") return;
	assert.notEqual(reinstalled.guard, result.guard);
	await switchHostFile(host, fileC);
	assert.equal(thirdPartyLoads, 2, "reinstall retains the third-party wrapper in the call chain");
	assert.equal(originalLoads, 2);
	assert.deepEqual(replacementFacts.facts.loadEntries, [fileC]);
}

async function retiredLoadAndSetRouteThroughReplacementGuard(): Promise<void> {
	const fileB = fakeFile("B.md");
	const fileC = fakeFile("C.md");
	const cEntered = deferred<void>();
	const releaseC = deferred<void>();
	let rawLoadCount = 0;
	let rawSetCount = 0;
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			rawLoadCount += 1;
			this.file = file;
			if (file === fileC) {
				cEntered.resolve();
				await releaseC.promise;
				return;
			}
			this.setViewData(`content:${file.path}`, true);
		},
		setViewData: function (data, _clear) {
			rawSetCount += 1;
			this.data = data;
		},
	});
	const first = installTextFileViewHandoffGuard(host, callbacksFor().callbacks);
	assert.equal(first.kind, "installed");
	if (first.kind !== "installed") return;
	const retiredLoad = host.onLoadFile;
	const retiredSet = host.setViewData;
	first.guard.restoreIfCurrent();

	const replacementFacts = callbacksFor({ sessionId: "boot-load-set-replacement" });
	const replacement = installTextFileViewHandoffGuard(host, replacementFacts.callbacks);
	assert.equal(replacement.kind, "installed");
	if (replacement.kind !== "installed") return;
	await retireSourceForNextLoad(host);
	await Reflect.apply(retiredLoad, makeOwnHost(), [fileB]);
	await retireSourceForNextLoad(host);
	const pendingC = host.onLoadFile(fileC);
	await cEntered.promise;
	Reflect.apply(retiredSet, makeOwnHost(), ["content:C", true]);
	releaseC.resolve();
	await pendingC;

	assert.equal(rawLoadCount, 2);
	assert.equal(rawSetCount, 2);
	assert.deepEqual(replacementFacts.facts.loadEntries, [fileB, fileC]);
	assert.deepEqual(
		replacementFacts.facts.setEntries.map((entry) => [entry.ticket.targetFile, entry.incomingContent]),
		[[fileB, "content:B.md"], [fileC, "content:C"]],
		"captured load and set wrappers both re-enter the exact replacement guard",
	);
	assert.equal(clearLoadCapabilityOf(replacement.guard), "observable");
}

async function restoredViewCanBeInstalledAgain(): Promise<void> {
	const fileB = fakeFile("B.md");
	const fileC = fakeFile("C.md");
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			this.file = file;
			this.setViewData(`content:${file.path}`, true);
		},
	});
	const firstFacts = callbacksFor();
	const first = installTextFileViewHandoffGuard(host, firstFacts.callbacks);
	assert.equal(first.kind, "installed");
	if (first.kind !== "installed") return;
	const capturedOldLoad = host.onLoadFile;
	first.guard.markInert();
	first.guard.restoreIfCurrent();

	const secondFacts = callbacksFor({ sessionId: "boot-b" });
	const second = installTextFileViewHandoffGuard(host, secondFacts.callbacks);
	assert.equal(second.kind, "installed");
	if (second.kind !== "installed") return;
	assert.notEqual(second.guard, first.guard, "restore removes the retired registry entry");
	assert.notEqual(host.onLoadFile, capturedOldLoad, "reinstall places a fresh active wrapper");
	const duplicate = installTextFileViewHandoffGuard(host, callbacksFor({ sessionId: "ignored" }).callbacks);
	assert.equal(duplicate.kind, "installed");
	if (duplicate.kind !== "installed") return;
	assert.equal(duplicate.guard, second.guard, "active reinstall remains idempotent");

	await switchHostFile(host, fileB);
	assert.deepEqual(firstFacts.facts.loadEntries, []);
	assert.deepEqual(secondFacts.facts.loadEntries, [fileB]);
	const other = makeOwnHost({ file: fakeFile("Other.md") });
	await retireSourceForNextLoad(host);
	await Reflect.apply(capturedOldLoad, other, [fileC]);
	assert.equal(host.file, fileC, "captured retired wrapper is bound original pass-through");
	assert.equal(other.file?.path, "Other.md");
	assert.deepEqual(firstFacts.facts.loadEntries, []);
	assert.deepEqual(
		secondFacts.facts.loadEntries,
		[fileB, fileC],
		"retired load routes through the exact replacement callbacks",
	);
}

async function retiredSaveWrappersRouteThroughTheReplacementGuard(): Promise<void> {
	const fileA = fakeFile("A.md");
	const fileB = fakeFile("B.md");
	const other = makeOwnHost({ file: fakeFile("Other.md") });
	let originalRequestCount = 0;
	let originalRunCount = 0;
	let originalSaveCount = 0;
	let bridgeRequestCount = 0;
	let bridgeRunCount = 0;
	let bridgeSaveCount = 0;
	let replacedPropertyRequestCount = 0;
	let replacedPropertySaveCount = 0;
	const host = makeOwnHost({
		file: fileA,
		onLoadFile: async function (file) {
			this.file = file;
			this.setViewData(`content:${file.path}`, true);
		},
		requestSave: Object.assign(function () {
			originalRequestCount += 1;
		}, {
			cancel() {},
			run() { originalRunCount += 1; },
		}),
		save: async function (clear?: boolean) {
			originalSaveCount += 1;
			if (clear === true) {
				this.data = "";
				this.lastSavedData = null;
			}
		},
	});
	const first = installTextFileViewHandoffGuard(host, callbacksFor().callbacks);
	assert.equal(first.kind, "installed");
	if (first.kind !== "installed") return;
	const retiredRequestSave = host.requestSave;
	const retiredRequestSaveRun = (retiredRequestSave as unknown as { run(): unknown }).run;
	const retiredSave = host.save;
	first.guard.markInert();
	first.guard.restoreIfCurrent();
	host.requestSave = Object.assign(function () {
		bridgeRequestCount += 1;
		return Reflect.apply(retiredRequestSave, host, []);
	}, {
		cancel() {},
		run() {
			bridgeRunCount += 1;
			return Reflect.apply(retiredRequestSaveRun, retiredRequestSave, []);
		},
	});
	host.save = async function (...args: unknown[]) {
		bridgeSaveCount += 1;
		await Reflect.apply(retiredSave, host, args);
	};

	const replacementFacts = callbacksFor({ sessionId: "boot-replacement" });
	const replacement = installTextFileViewHandoffGuard(host, replacementFacts.callbacks);
	assert.equal(replacement.kind, "installed");
	if (replacement.kind !== "installed") return;
	await switchHostFile(host, fileB);
	originalSaveCount = 0;
	bridgeSaveCount = 0;
	replacement.guard.beginBlockingHandoff({
		handoffGeneration: 1,
		sourceLineagePath: "A.md",
		targetPath: "B.md",
	});
	host.file = fileA;
	host.requestSave = Object.assign(function () {
		replacedPropertyRequestCount += 1;
	}, { cancel() {} });
	host.save = async function () {
		replacedPropertySaveCount += 1;
	};

	Reflect.apply(retiredRequestSave, other, []);
	Reflect.apply(retiredRequestSaveRun, retiredRequestSave, []);
	await Reflect.apply(retiredSave, other, []);

	assert.equal(originalRequestCount, 0, "retired requestSave cannot bypass a replacement guard");
	assert.equal(originalRunCount, 0, "retired requestSave.run cannot bypass a replacement guard");
	assert.equal(originalSaveCount, 0, "retired save cannot bypass a replacement guard");
	assert.equal(bridgeRequestCount, 0);
	assert.equal(bridgeRunCount, 0);
	assert.equal(bridgeSaveCount, 0);
	assert.equal(replacedPropertyRequestCount, 0, "routing uses the registered wrapper, not a replaced property");
	assert.equal(replacedPropertySaveCount, 0, "third-party replacements are not re-entered recursively");
	assert.deepEqual(
		replacementFacts.facts.suppressed.map((entry) => entry.invocationPath),
		["A.md", "A.md", "A.md"],
	);

	host.file = fileB;
	host.data = "content:B";
	assert.equal(replacement.guard.markTargetProven({
		handoffGeneration: 1,
		targetFile: fileB,
		certifiedContent: "content:B",
	}), true);
	Reflect.apply(retiredRequestSave, other, []);
	Reflect.apply(retiredRequestSaveRun, retiredRequestSave, []);
	await Reflect.apply(retiredSave, other, []);
	assert.deepEqual(
		[bridgeRequestCount, bridgeRunCount, bridgeSaveCount],
		[0, 0, 1],
		"future request scheduling remains owned while direct save may use the bridge",
	);
	assert.deepEqual(
		[originalRequestCount, originalRunCount, originalSaveCount],
		[0, 0, 1],
		"request bridges cannot regain scheduler ownership after target proof",
	);
	assert.equal(replacedPropertyRequestCount, 0);
	assert.equal(replacedPropertySaveCount, 0);
}

async function asyncDelegationFramesPreserveBridgeTailsAndIdentity(): Promise<void> {
	const fileB = fakeFile("B.md");
	const recursionError = new Error("replacement bridge recursed");
	const setError = new Error("raw set error");
	const saveError = new Error("raw save error");
	const requestSentinel = { kind: "request-sentinel" };
	const runSentinel = { kind: "run-sentinel" };
	let rawLoadCount = 0;
	let rawSetCount = 0;
	let rawRequestCount = 0;
	let rawRunCount = 0;
	let rawSaveCount = 0;
	const host = makeOwnHost({
		onLoadFile: function (file) {
			rawLoadCount += 1;
			this.file = file;
			this.setViewData(`content:${file.path}`, true);
			return Promise.resolve();
		},
		setViewData: function (data, _clear) {
			rawSetCount += 1;
			if (data === "throw") throw setError;
			this.data = data;
		},
		requestSave: Object.assign(function () {
			rawRequestCount += 1;
			return requestSentinel;
		}, {
			cancel() {},
			run() {
				rawRunCount += 1;
				return runSentinel;
			},
		}),
		save: function (marker?: unknown) {
			rawSaveCount += 1;
			if (marker === true) {
				this.data = "";
				this.lastSavedData = null;
			}
			return marker === "reject" ? Promise.reject(saveError) : Promise.resolve("saved");
		},
	});
	const first = installTextFileViewHandoffGuard(host, callbacksFor().callbacks);
	assert.equal(first.kind, "installed");
	if (first.kind !== "installed") return;
	const retiredLoad = host.onLoadFile;
	const retiredSet = host.setViewData;
	const retiredRequestSave = host.requestSave;
	const retiredRun = (retiredRequestSave as unknown as { run(...args: unknown[]): unknown }).run;
	const retiredSave = host.save;
	first.guard.restoreIfCurrent();

	let bridgeLoadCount = 0;
	let bridgeSetCount = 0;
	let bridgeRequestCount = 0;
	let bridgeRunCount = 0;
	let bridgeSaveCount = 0;
	let loadBridgePending = false;
	let runBridgePending = false;
	let saveBridgePending = false;
	let bridgeLoadPromise: Promise<void> | null = null;
	let bridgeRunPromise: Promise<unknown> | null = null;
	let bridgeSavePromise: Promise<void> | null = null;
	host.onLoadFile = function (file, ...args: unknown[]) {
		bridgeLoadCount += 1;
		if (loadBridgePending) return Promise.reject(recursionError);
		loadBridgePending = true;
		const promise = (async (): Promise<void> => {
			await Promise.resolve();
			await Reflect.apply(retiredLoad, host, [file, ...args]);
		})();
		bridgeLoadPromise = promise;
		void promise.then(
			() => { loadBridgePending = false; },
			() => { loadBridgePending = false; },
		);
		return promise;
	};
	host.setViewData = function (data, clear, ...args: unknown[]) {
		bridgeSetCount += 1;
		if (bridgeSetCount > rawSetCount + 1) throw recursionError;
		return Reflect.apply(retiredSet, host, [data, clear, ...args]);
	};
	host.requestSave = Object.assign(function (...args: unknown[]) {
		bridgeRequestCount += 1;
		if (bridgeRequestCount > rawRequestCount + 1) throw recursionError;
		return Reflect.apply(retiredRequestSave, host, args);
	}, {
		cancel() {},
		run(...args: unknown[]) {
			bridgeRunCount += 1;
			if (runBridgePending) return Promise.reject(recursionError);
			runBridgePending = true;
			const promise = (async (): Promise<unknown> => {
				await Promise.resolve();
				return Reflect.apply(retiredRun, retiredRequestSave, args);
			})();
			bridgeRunPromise = promise;
			void promise.then(
				() => { runBridgePending = false; },
				() => { runBridgePending = false; },
			);
			return promise;
		},
	});
	host.save = function (...args: unknown[]) {
		bridgeSaveCount += 1;
		if (saveBridgePending) return Promise.reject(recursionError);
		saveBridgePending = true;
		const rawTail = Reflect.apply(retiredSave, host, args);
		const promise = (async (): Promise<void> => {
			await rawTail;
		})();
		bridgeSavePromise = promise;
		void promise.then(
			() => { saveBridgePending = false; },
			() => { saveBridgePending = false; },
		);
		return promise;
	};

	const replacementFacts = callbacksFor({
		sessionId: "boot-async-bridge",
		saveOwnershipContext: () => {
			const file = host.file;
			return file === null ? null : {
				sessionId: "boot-async-bridge",
				generation: 1,
				file,
				path: file.path,
				displayedPath: file.path,
			};
		},
		isSaveOwnershipContextCurrent: (context) =>
			context.sessionId === "boot-async-bridge"
			&& context.generation === 1
			&& context.file === host.file
			&& context.path === host.file?.path
			&& context.displayedPath === host.file?.path,
	});
	const replacement = installTextFileViewHandoffGuard(host, replacementFacts.callbacks);
	assert.equal(replacement.kind, "installed");
	if (replacement.kind !== "installed") return;
	await retireSourceForNextLoad(host);
	bridgeSaveCount = 0;
	rawSaveCount = 0;
	const loadResult = Reflect.apply(retiredLoad, makeOwnHost(), [fileB]);
	assert.equal(loadResult, bridgeLoadPromise, "load returns the third-party bridge promise unchanged");
	await loadResult;
	assert.throws(
		() => Reflect.apply(retiredSet, makeOwnHost(), ["throw", false]),
		(error: unknown) => error === setError,
	);
	assert.equal(Reflect.apply(retiredRequestSave, makeOwnHost(), []), undefined);
	assert.notEqual(replacement.guard.snapshot().pendingOwnedSave, null);
	(host.requestSave as unknown as { cancel(): void }).cancel();
	const runResult = Reflect.apply(retiredRun, retiredRequestSave, []) as Promise<unknown>;
	assert.notEqual(runResult, bridgeRunPromise, "requestSave.run stays on the owned scheduler");
	assert.equal(await runResult, undefined);
	const saveResult = Reflect.apply(retiredSave, makeOwnHost(), ["reject"]);
	const capturedBridgeSave = required<Promise<void>>(
		bridgeSavePromise ?? undefined,
		"captured bridge save promise",
	);
	assert.equal(saveResult, capturedBridgeSave, "save returns the bridge promise unchanged");
	await assert.rejects(saveResult, (error: unknown) => error === saveError);

	assert.deepEqual(
		[bridgeLoadCount, bridgeSetCount, bridgeRequestCount, bridgeRunCount, bridgeSaveCount],
		[1, 2, 0, 0, 1],
	);
	assert.deepEqual(
		[rawLoadCount, rawSetCount, rawRequestCount, rawRunCount, rawSaveCount],
		[1, 2, 0, 0, 1],
		"load/save bridges reach raw tails while future request scheduling stays owned",
	);
	assert.deepEqual(replacementFacts.facts.loadEntries, [fileB]);
	assert.equal(replacementFacts.facts.setEntries.length, 1);

	replacement.guard.beginBlockingHandoff({
		handoffGeneration: 1,
		sourceLineagePath: "A.md",
		targetPath: "B.md",
	});
	const countsBeforeBlock = [
		bridgeRequestCount,
		bridgeRunCount,
		bridgeSaveCount,
		rawRequestCount,
		rawRunCount,
		rawSaveCount,
	];
	assert.equal(Reflect.apply(retiredRequestSave, makeOwnHost(), []), undefined);
	assert.equal(Reflect.apply(retiredRun, retiredRequestSave, []), undefined);
	await Reflect.apply(retiredSave, makeOwnHost(), []);
	assert.deepEqual([
		bridgeRequestCount,
		bridgeRunCount,
		bridgeSaveCount,
		rawRequestCount,
		rawRunCount,
		rawSaveCount,
	], countsBeforeBlock, "blocking suppresses before any third-party or raw delegation");
	assert.equal(replacementFacts.facts.suppressed.length, 3);
}

async function concurrentRetiredLoadBridgesPreserveClearCapability(): Promise<void> {
	const fileB = fakeFile("B.md");
	const fileC = fakeFile("C.md");
	const fileD = fakeFile("D.md");
	const bridgeGates = [deferred<void>(), deferred<void>()];
	const rawRelease = deferred<void>();
	const bridgePromises: Promise<void>[] = [];
	let rawLoadCount = 0;
	let rawClearCount = 0;
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			rawLoadCount += 1;
			this.file = file;
			this.setViewData(`content:${file.path}`, true);
			await rawRelease.promise;
		},
		setViewData: function (data, clear) {
			this.data = data;
			if (clear) rawClearCount += 1;
		},
	});
	const first = installTextFileViewHandoffGuard(host, callbacksFor().callbacks);
	assert.equal(first.kind, "installed");
	if (first.kind !== "installed") return;
	const retiredLoad = host.onLoadFile;
	first.guard.restoreIfCurrent();

	host.onLoadFile = function (file) {
		const bridgeIndex = bridgePromises.length;
		if (bridgeIndex >= bridgeGates.length) {
			return Reflect.apply(retiredLoad, host, [file]);
		}
		const promise = (async (): Promise<void> => {
			await required(bridgeGates[bridgeIndex], "retired load bridge gate").promise;
			await Reflect.apply(retiredLoad, host, [file]);
		})();
		bridgePromises.push(promise);
		return promise;
	};
	const replacementFacts = callbacksFor();
	const replacement = installTextFileViewHandoffGuard(host, replacementFacts.callbacks);
	assert.equal(replacement.kind, "installed");
	if (replacement.kind !== "installed") return;

	const pendingB = host.onLoadFile(fileB);
	const pendingC = host.onLoadFile(fileC);
	assert.equal(pendingB, bridgePromises[0], "first load returns the bridge promise unchanged");
	assert.equal(pendingC, bridgePromises[1], "second load returns the bridge promise unchanged");
	for (const gate of bridgeGates) gate.resolve();
	await Promise.resolve();
	assert.deepEqual(
		[rawLoadCount, rawClearCount],
		[2, 2],
		"save-lane ambiguity hardening does not revoke concurrent load bridges",
	);
	rawRelease.resolve();
	await Promise.all([pendingB, pendingC]);
	assert.equal(clearLoadCapabilityOf(replacement.guard), "observable");

	await switchHostFile(host, fileD);
	const dEntry = required(replacementFacts.facts.setEntries[0], "post-bridge D entry");
	assert.equal(dEntry.ticket.targetFile, fileD);
	const candidate = makeHostLoadCandidate({
		hostLoadTokenId: `host-load:${dEntry.ticket.switchIntentSeq}`,
		ticket: dEntry.ticket,
		view: host,
		incomingContent: dEntry.incomingContent,
	});
	const receipt = makeHostLoadReceipt(candidate);
	assert.equal(replacement.guard.reportHostLoadCandidate(candidate), true);
	assert.equal(replacement.guard.reportHostLoadCompleted(receipt), true);
	assert.deepEqual(replacementFacts.facts.candidates, [candidate]);
	assert.deepEqual(replacementFacts.facts.completions, [receipt]);
}

type SaveDelegationLane = "requestSave" | "requestSave.run" | "save";

async function blockingHandoffRevokesPendingSaveDelegationFrames(): Promise<void> {
	const fileB = fakeFile("B.md");
	const gates = new Map<SaveDelegationLane, Deferred<void>>([
		["requestSave", deferred<void>()],
		["requestSave.run", deferred<void>()],
		["save", deferred<void>()],
	]);
	const bridgePromises = new Map<SaveDelegationLane, Promise<unknown>>();
	let rawRequestCount = 0;
	let rawRunCount = 0;
	let rawSaveCount = 0;
	let cancelCount = 0;
	const host = makeOwnHost({
		onLoadFile: async function (file) {
			this.file = file;
			this.setViewData(`content:${file.path}`, true);
		},
		requestSave: Object.assign(function () {
			rawRequestCount += 1;
			return Promise.resolve("raw request");
		}, {
			cancel() {},
			run() {
				rawRunCount += 1;
				return Promise.resolve("raw run");
			},
		}),
		save: function (clear?: boolean) {
			rawSaveCount += 1;
			if (clear === true) {
				this.data = "";
				this.lastSavedData = null;
			}
			return Promise.resolve();
		},
	});
	const first = installTextFileViewHandoffGuard(host, callbacksFor().callbacks);
	assert.equal(first.kind, "installed");
	if (first.kind !== "installed") return;
	const retiredRequestSave = host.requestSave;
	const retiredRun = (retiredRequestSave as unknown as { run(): unknown }).run;
	const retiredSave = host.save;
	first.guard.restoreIfCurrent();

	const bridgeRequestSave = Object.assign(function () {
		const promise = (async (): Promise<unknown> => {
			await required(gates.get("requestSave"), "requestSave gate").promise;
			return Reflect.apply(retiredRequestSave, host, []);
		})();
		bridgePromises.set("requestSave", promise);
		return promise;
	}, {
		cancel() { cancelCount += 1; },
		run() {
			const promise = (async (): Promise<unknown> => {
				await required(gates.get("requestSave.run"), "requestSave.run gate").promise;
				return Reflect.apply(retiredRun, retiredRequestSave, []);
			})();
			bridgePromises.set("requestSave.run", promise);
			return promise;
		},
	});
	host.requestSave = bridgeRequestSave;
	host.save = function (...args: unknown[]) {
		if (args[0] === true) {
			return Reflect.apply(retiredSave, host, args);
		}
		const promise = (async (): Promise<void> => {
			await required(gates.get("save"), "save gate").promise;
			await Reflect.apply(retiredSave, host, args);
		})();
		bridgePromises.set("save", promise);
		return promise;
	};

	const replacementFacts = callbacksFor({
		sessionId: "boot-block-revoke",
		saveOwnershipContext: () => {
			const file = host.file;
			return file === null ? null : {
				sessionId: "boot-block-revoke",
				generation: 1,
				file,
				path: file.path,
				displayedPath: file.path,
			};
		},
		isSaveOwnershipContextCurrent: (context) =>
			context.sessionId === "boot-block-revoke"
			&& context.generation === 1
			&& context.file === host.file
			&& context.path === host.file?.path
			&& context.displayedPath === host.file?.path,
	});
	const replacement = installTextFileViewHandoffGuard(host, replacementFacts.callbacks);
	assert.equal(replacement.kind, "installed");
	if (replacement.kind !== "installed") return;
	await switchHostFile(host, fileB);
	rawSaveCount = 0;
	const requestResult = Reflect.apply(host.requestSave, host, []);
	assert.equal(requestResult, undefined);
	assert.notEqual(replacement.guard.snapshot().pendingOwnedSave, null);
	const saveResult = Reflect.apply(host.save, host, []) as Promise<unknown>;
	assert.equal(saveResult, bridgePromises.get("save"));

	replacement.guard.beginBlockingHandoff({
		handoffGeneration: 1,
		sourceLineagePath: "A.md",
		targetPath: "B.md",
	});
	assert.equal(replacement.guard.snapshot().pendingOwnedSave, null);
	assert.equal(Reflect.apply(host.requestSave, host, []), undefined);
	assert.equal(Reflect.apply(
		(host.requestSave as unknown as { run(): unknown }).run,
		host.requestSave,
		[],
	), undefined);
	for (const gate of gates.values()) gate.resolve();
	await saveResult;

	assert.deepEqual(
		[rawRequestCount, rawRunCount, rawSaveCount],
		[0, 0, 0],
		"blocking cancels owned requests and revokes the pending save bridge",
	);
	assert.equal(
		cancelCount,
		2,
		"source unload and blocking handoff each cancel the replacement debouncer once",
	);
	assert.deepEqual(
		replacementFacts.facts.suppressed.map((entry) => entry.invocationPath),
		["B.md", "B.md", "B.md"],
		"each late retired tail remains observable as a suppressed save",
	);
}

async function concurrentAsyncSaveDelegationLaneFailsClosed(
	lane: SaveDelegationLane,
): Promise<void> {
	const rawError = new Error(`${lane} raw error`);
	let rawTailCount = 0;
	const host = makeOwnHost({
		requestSave: Object.assign(function (marker?: unknown) {
			if (lane !== "requestSave") return undefined;
			rawTailCount += 1;
			return marker === "reject"
				? Promise.reject(rawError)
				: Promise.resolve("raw request");
		}, {
			cancel() {},
			run(marker?: unknown) {
				if (lane !== "requestSave.run") return undefined;
				rawTailCount += 1;
				return marker === "reject"
					? Promise.reject(rawError)
					: Promise.resolve("raw run");
			},
		}),
		save: function (marker?: unknown) {
			if (lane !== "save") return Promise.resolve();
			rawTailCount += 1;
			return marker === "reject" ? Promise.reject(rawError) : Promise.resolve();
		},
	});
	const first = installTextFileViewHandoffGuard(host, callbacksFor().callbacks);
	assert.equal(first.kind, "installed");
	if (first.kind !== "installed") return;
	const retiredRequestSave = host.requestSave;
	const retiredRun = (retiredRequestSave as unknown as { run(marker?: unknown): unknown }).run;
	const retiredSave = host.save;
	first.guard.restoreIfCurrent();

	const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
	const bridgePromises: Promise<unknown>[] = [];
	const startBridge = (
		invokeTail: (marker: "ambiguous" | "reject") => unknown,
	): Promise<unknown> => {
		const invocationIndex = bridgePromises.length;
		const promise = (async (): Promise<unknown> => {
			await required(gates[invocationIndex], `${lane} bridge gate`).promise;
			const marker = invocationIndex === 2 ? "reject" : "ambiguous";
			const tailCount = invocationIndex === 0 ? 2 : 1;
			let result: unknown;
			for (let index = 0; index < tailCount; index += 1) {
				result = await invokeTail(marker);
			}
			return result;
		})();
		bridgePromises.push(promise);
		return promise;
	};
	host.requestSave = Object.assign(function () {
		if (lane !== "requestSave") return undefined;
		return startBridge((marker) => Reflect.apply(retiredRequestSave, host, [marker]));
	}, {
		cancel() {},
		run() {
			if (lane !== "requestSave.run") return undefined;
			return startBridge((marker) => Reflect.apply(retiredRun, retiredRequestSave, [marker]));
		},
	});
	host.save = function () {
		if (lane !== "save") return Promise.resolve();
		return startBridge((marker) => Reflect.apply(retiredSave, host, [marker])) as Promise<void>;
	};

	const { callbacks } = callbacksFor({
		saveOwnershipContext: () => {
			const file = host.file;
			return file === null ? null : {
				sessionId: "boot-a",
				generation: 1,
				file,
				path: file.path,
				displayedPath: file.path,
			};
		},
		isSaveOwnershipContextCurrent: (context) =>
			context.sessionId === "boot-a"
			&& context.generation === 1
			&& context.file === host.file
			&& context.path === host.file?.path
			&& context.displayedPath === host.file?.path,
	});
	const replacement = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(replacement.kind, "installed");
	if (replacement.kind !== "installed") return;
	const invokeCurrent = (): unknown => {
		if (lane === "requestSave") return Reflect.apply(host.requestSave, host, []);
		if (lane === "requestSave.run") {
			return Reflect.apply(
				(host.requestSave as unknown as { run(): unknown }).run,
				host.requestSave,
				[],
			);
		}
		return Reflect.apply(host.save, host, []);
	};

	const firstResult = invokeCurrent() as Promise<unknown>;
	const secondResult = invokeCurrent() as Promise<unknown>;
	assert.equal(firstResult, bridgePromises[0], `${lane} first thenable identity`);
	assert.equal(secondResult, bridgePromises[1], `${lane} second thenable identity`);
	required(gates[0], `${lane} first gate`).resolve();
	required(gates[1], `${lane} second gate`).resolve();
	await Promise.all([firstResult, secondResult]);
	assert.equal(rawTailCount, 0, `${lane} concurrent ambiguity fails closed`);

	const cleanResult = invokeCurrent() as Promise<unknown>;
	assert.equal(cleanResult, bridgePromises[2], `${lane} clean thenable identity`);
	required(gates[2], `${lane} clean gate`).resolve();
	await assert.rejects(cleanResult, (error: unknown) => error === rawError);
	assert.equal(rawTailCount, 1, `${lane} later single bridge reaches its raw tail once`);
}

async function concurrentAsyncSaveDelegationLanesFailClosed(): Promise<void> {
	for (const lane of ["save"] as const) {
		await concurrentAsyncSaveDelegationLaneFailsClosed(lane);
	}
}

async function distinctSaveDelegationLanesDoNotStealFrames(): Promise<void> {
	const gates = new Map<SaveDelegationLane, Deferred<void>>([
		["requestSave", deferred<void>()],
		["requestSave.run", deferred<void>()],
		["save", deferred<void>()],
	]);
	const bridgePromises = new Map<SaveDelegationLane, Promise<unknown>>();
	let rawRequestCount = 0;
	let rawRunCount = 0;
	let rawSaveCount = 0;
	const host = makeOwnHost({
		requestSave: Object.assign(function () {
			rawRequestCount += 1;
			return Promise.resolve();
		}, {
			cancel() {},
			run() {
				rawRunCount += 1;
				return Promise.resolve();
			},
		}),
		save: function () {
			rawSaveCount += 1;
			return Promise.resolve();
		},
	});
	const first = installTextFileViewHandoffGuard(host, callbacksFor().callbacks);
	assert.equal(first.kind, "installed");
	if (first.kind !== "installed") return;
	const retiredRequestSave = host.requestSave;
	const retiredRun = (retiredRequestSave as unknown as { run(): unknown }).run;
	const retiredSave = host.save;
	first.guard.restoreIfCurrent();

	host.requestSave = Object.assign(function () {
		const promise = (async (): Promise<void> => {
			await required(gates.get("requestSave"), "request lane gate").promise;
			await Reflect.apply(retiredRequestSave, host, []);
			await Reflect.apply(retiredRequestSave, host, []);
		})();
		bridgePromises.set("requestSave", promise);
		return promise;
	}, {
		cancel() {},
		run() {
			const promise = (async (): Promise<void> => {
				await required(gates.get("requestSave.run"), "run lane gate").promise;
				await Reflect.apply(retiredRun, retiredRequestSave, []);
			})();
			bridgePromises.set("requestSave.run", promise);
			return promise;
		},
	});
	host.save = function () {
		const promise = (async (): Promise<void> => {
			await required(gates.get("save"), "save lane gate").promise;
			await Reflect.apply(retiredSave, host, []);
		})();
		bridgePromises.set("save", promise);
		return promise;
	};
	const { callbacks } = callbacksFor({
		saveOwnershipContext: () => {
			const file = host.file;
			return file === null ? null : {
				sessionId: "boot-a",
				generation: 1,
				file,
				path: file.path,
				displayedPath: file.path,
			};
		},
		isSaveOwnershipContextCurrent: (context) =>
			context.sessionId === "boot-a"
			&& context.generation === 1
			&& context.file === host.file
			&& context.path === host.file?.path
			&& context.displayedPath === host.file?.path,
	});
	const replacement = installTextFileViewHandoffGuard(host, callbacks);
	assert.equal(replacement.kind, "installed");
	if (replacement.kind !== "installed") return;

	const requestResult = Reflect.apply(host.requestSave, host, []);
	assert.equal(requestResult, undefined);
	assert.notEqual(replacement.guard.snapshot().pendingOwnedSave, null);
	(host.requestSave as unknown as { cancel(): void }).cancel();
	const runResult = Reflect.apply(
		(host.requestSave as unknown as { run(): unknown }).run,
		host.requestSave,
		[],
	) as Promise<unknown>;
	const saveResult = Reflect.apply(host.save, host, []) as Promise<unknown>;
	assert.equal(bridgePromises.get("requestSave"), undefined);
	assert.equal(bridgePromises.get("requestSave.run"), undefined);
	assert.equal(saveResult, bridgePromises.get("save"));
	required(gates.get("save"), "save lane gate").resolve();
	await Promise.all([runResult, saveResult]);
	assert.deepEqual(
		[rawRequestCount, rawRunCount, rawSaveCount],
		[0, 0, 1],
		"owned request scheduling bypasses request bridges without stealing save delegation",
	);
}

function unsupportedHostsAreAtomic(): void {
	const missingDirty = makeOwnHost();
	assert.equal(Reflect.deleteProperty(missingDirty, "dirty"), true);
	const missingDirtyBefore = ownDescriptors(missingDirty);
	assert.deepEqual(installTextFileViewHandoffGuard(
		missingDirty,
		callbacksFor().callbacks,
	), {
		kind: "unsupported",
		reason: "unsupported-host-adapter",
	});
	assertOwnDescriptorsEqual(missingDirty, missingDirtyBefore);

	const readonlyDirty = makeOwnHost();
	Object.defineProperty(readonlyDirty, "dirty", {
		configurable: true,
		enumerable: true,
		value: false,
		writable: false,
	});
	const readonlyDirtyBefore = ownDescriptors(readonlyDirty);
	assert.deepEqual(installTextFileViewHandoffGuard(
		readonlyDirty,
		callbacksFor().callbacks,
	), {
		kind: "unsupported",
		reason: "unsupported-host-adapter",
	});
	assertOwnDescriptorsEqual(readonlyDirty, readonlyDirtyBefore);

	const noCancel = makeOwnHost({ requestSave: function () {} });
	const noCancelBefore = ownDescriptors(noCancel);
	assert.deepEqual(installTextFileViewHandoffGuard(noCancel, callbacksFor().callbacks, {
		hostApiVersion: "unknown",
	}), {
		kind: "unsupported",
		reason: "unsupported-host-adapter",
	});
	assertOwnDescriptorsEqual(noCancel, noCancelBefore);

	const unknownPublic = makeOwnHost();
	const unknownPublicBefore = ownDescriptors(unknownPublic);
	assert.deepEqual(installTextFileViewHandoffGuard(unknownPublic, callbacksFor().callbacks, {
		hostApiVersion: "9.9.9",
	}), {
		kind: "unsupported",
		reason: "unsupported-host-adapter",
	});
	assertOwnDescriptorsEqual(unknownPublic, unknownPublicBefore);

	const testedPublic = makeOwnHost();
	const testedPublicResult = installTextFileViewHandoffGuard(
		testedPublic,
		callbacksFor().callbacks,
	);
	assert.equal(testedPublicResult.kind, "installed");
	if (testedPublicResult.kind === "installed") {
		assert.equal(testedPublicResult.guard.snapshot().hostCapability, "public-cancellable");
		testedPublicResult.guard.restoreIfCurrent();
	}

	const unwrappableUnload = makeOwnHost();
	const unloadDescriptor = Object.getOwnPropertyDescriptor(unwrappableUnload, "onUnloadFile");
	assert.notEqual(unloadDescriptor, undefined);
	Object.defineProperty(unwrappableUnload, "onUnloadFile", {
		...unloadDescriptor,
		configurable: false,
		writable: false,
	});
	const unwrappableUnloadBefore = ownDescriptors(unwrappableUnload);
	assert.deepEqual(installTextFileViewHandoffGuard(
		unwrappableUnload,
		callbacksFor().callbacks,
	), {
		kind: "unsupported",
		reason: "method-not-wrappable",
	});
	assertOwnDescriptorsEqual(unwrappableUnload, unwrappableUnloadBefore);

	const narrowClear = makeOwnHost({
		setViewData: function (this: Host, data: string) { this.data = data; },
	});
	const narrowBefore = ownDescriptors(narrowClear);
	assert.deepEqual(installTextFileViewHandoffGuard(narrowClear, callbacksFor().callbacks), {
		kind: "unsupported",
		reason: "clear-load-not-observable",
	});
	assertOwnDescriptorsEqual(narrowClear, narrowBefore);

	const inherited = Object.create(Object.getPrototypeOf(makeOwnHost())) as Host;
	const prototype = {
		file: fakeFile("A.md"),
		data: "content:A",
		getViewData(this: Host) { return this.data; },
		async onLoadFile(this: Host, file: TFile) { this.file = file; },
		setViewData(this: Host, data: string, _clear: boolean) { this.data = data; },
		requestSave: cancellable(function () {}),
		async save() {},
	};
	Object.setPrototypeOf(inherited, prototype);
	Object.preventExtensions(inherited);
	const namesBefore = Object.getOwnPropertyNames(inherited);
	assert.deepEqual(installTextFileViewHandoffGuard(inherited, callbacksFor().callbacks), {
		kind: "unsupported",
		reason: "method-not-wrappable",
	});
	assert.deepEqual(Object.getOwnPropertyNames(inherited), namesBefore);

	const rollbackTarget = makeOwnHost();
	const rollbackBefore = ownDescriptors(rollbackTarget);
	const rollbackProxy = new Proxy(rollbackTarget, {
		defineProperty(target, property, descriptor) {
			if (property === "setViewData" && descriptor.value !== rollbackBefore.get(property)?.value) {
				return false;
			}
			return Reflect.defineProperty(target, property, descriptor);
		},
	});
	assert.deepEqual(installTextFileViewHandoffGuard(rollbackProxy, callbacksFor().callbacks), {
		kind: "unsupported",
		reason: "method-not-wrappable",
	});
	assertOwnDescriptorsEqual(rollbackTarget, rollbackBefore);
}

async function testedPrivateHostUsesOwnedFutureScheduler(): Promise<void> {
	const fileA = fakeFile("A.md");
	let generation = 4;
	let nativeRequestCount = 0;
	let saveCount = 0;
	const host = makeOwnHost({
		file: fileA,
		requestSave: function () {
			nativeRequestCount += 1;
		},
		save: async function () {
			saveCount += 1;
		},
	});
	const { callbacks, facts } = callbacksFor({
		generation: () => generation,
		saveOwnershipContext: () => ({
			sessionId: "boot-a",
			generation,
			file: fileA,
			path: fileA.path,
			displayedPath: fileA.path,
		}),
		isSaveOwnershipContextCurrent: (context) =>
			context.sessionId === "boot-a"
			&& context.generation === generation
			&& context.file === host.file
			&& context.path === host.file?.path
			&& context.displayedPath === host.file?.path,
	});
	const result = installTextFileViewHandoffGuard(host, callbacks, {
		hostApiVersion: "1.13.4",
		requestSaveDelayMs: 60_000,
	});
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;

	assert.equal(result.guard.snapshot().hostCapability, "owned-scheduler-with-unload-flush");
	const initialEpoch = result.guard.snapshot().saveEpoch;
	host.requestSave();
	const firstScheduled = result.guard.snapshot();
	assert.ok(firstScheduled.saveEpoch > initialEpoch);
	generation = 5;
	host.requestSave();
	const scheduled = result.guard.snapshot();
	assert.ok(scheduled.saveEpoch > firstScheduled.saveEpoch);
	assert.equal(nativeRequestCount, 0, "future scheduling never enters the private native debouncer");
	assert.equal(saveCount, 0);
	assert.deepEqual(scheduled.pendingOwnedSave && {
		sessionId: scheduled.pendingOwnedSave.sessionId,
		generation: scheduled.pendingOwnedSave.generation,
		file: scheduled.pendingOwnedSave.file,
		path: scheduled.pendingOwnedSave.path,
		displayedPath: scheduled.pendingOwnedSave.displayedPath,
	}, {
		sessionId: "boot-a",
		generation: 5,
		file: fileA,
		path: "A.md",
		displayedPath: "A.md",
	});

	(result.guard.snapshot().installedRequestSave as unknown as { cancel(): void }).cancel();
	const cancelled = result.guard.snapshot();
	assert.equal(cancelled.pendingOwnedSave, null);
	assert.ok(cancelled.saveEpoch > scheduled.saveEpoch);
	host.requestSave();
	const beforeFirstFlush = result.guard.snapshot().saveEpoch;
	await (host.requestSave as unknown as { flush(): Promise<void> }).flush();
	assert.equal(saveCount, 1, "owned flush enters the guarded save lane once");
	assert.ok(
		result.guard.snapshot().saveEpoch >= beforeFirstFlush + 3,
		"flush, guarded save entry, and settlement each advance the save epoch",
	);
	assert.equal(nativeRequestCount, 0);

	host.requestSave();
	const beforeRun = result.guard.snapshot().saveEpoch;
	await (host.requestSave as unknown as { run(): Promise<void> }).run();
	assert.equal(saveCount, 2, "owned run aliases the same one-shot flush");
	assert.ok(result.guard.snapshot().saveEpoch >= beforeRun + 3);

	host.requestSave();
	const staleJob = result.guard.snapshot().pendingOwnedSave;
	assert.notEqual(staleJob, null);
	generation = 6;
	await result.guard.flushOwnedSave();
	assert.equal(saveCount, 2, "a stale generation cannot enter native save");
	assert.deepEqual(facts.suppressed.at(-1), {
		sessionId: "boot-a",
		handoffGeneration: 5,
		invocationFile: fileA,
		invocationPath: "A.md",
	});

	host.requestSave();
	generation = 7;
	result.guard.beginBlockingHandoff({
		handoffGeneration: generation,
		sourceLineagePath: "A.md",
		targetPath: "B.md",
	});
	assert.equal(result.guard.snapshot().pendingOwnedSave, null);
	assert.equal(saveCount, 2);
	assert.equal(nativeRequestCount, 0);
	assert.deepEqual(facts.capabilityLosses, []);
}

async function testedPublicHostUsesOwnedFutureSchedulerAndTeardownDrain(): Promise<void> {
	const fileA = fakeFile("A.md");
	const saveGate = deferred<void>();
	let nativeRequestCount = 0;
	let nativeRunCount = 0;
	let saveEntryCount = 0;
	const publicRequestSave = Object.assign(
		function () {
			nativeRequestCount += 1;
		},
		{
			cancel() {},
			run() {
				nativeRunCount += 1;
			},
		},
	);
	const host = makeOwnHost({
		file: fileA,
		requestSave: publicRequestSave,
		save: async function () {
			saveEntryCount += 1;
			await saveGate.promise;
		},
	});
	const { callbacks, facts } = callbacksFor({
		sessionId: "boot-public",
		generation: () => 7,
		saveOwnershipContext: () => ({
			sessionId: "boot-public",
			generation: 7,
			file: fileA,
			path: fileA.path,
			displayedPath: fileA.path,
		}),
		isSaveOwnershipContextCurrent: (context) =>
			context.sessionId === "boot-public"
			&& context.generation === 7
			&& context.file === host.file
			&& context.path === host.file?.path
			&& context.displayedPath === host.file?.path,
	});
	const result = installTextFileViewHandoffGuard(host, callbacks, {
		hostApiVersion: "1.8.4",
		requestSaveDelayMs: 60_000,
	});
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;
	assert.equal(result.guard.snapshot().hostCapability, "public-cancellable");

	host.requestSave();
	assert.equal(nativeRequestCount, 0, "future public scheduling is owned by KAOS");
	assert.equal(nativeRunCount, 0);
	assert.equal(
		result.guard.snapshot().hostCapabilityState,
		"ready",
		`public scheduler capability lost: ${facts.capabilityLosses.join(",")}`,
	);
	assert.notEqual(
		result.guard.snapshot().pendingOwnedSave,
		null,
		"a public-cancellable request is visible to the teardown drain",
	);

	let drainSettled = false;
	const drain = result.guard.flushOwnedSave().then(() => {
		drainSettled = true;
	});
	assert.equal(saveEntryCount, 1, "teardown synchronously enters the pending save exactly once");
	result.guard.markInert();
	await Promise.resolve();
	assert.equal(drainSettled, false, "teardown awaits the already-entered public-host save");
	assert.equal(saveEntryCount, 1);

	saveGate.resolve();
	await drain;
	assert.equal(drainSettled, true);
	assert.equal(saveEntryCount, 1);
	assert.equal(nativeRequestCount, 0);
	assert.equal(nativeRunCount, 0);
}

async function ownedFutureSchedulersPreserveTheSynchronousDirtyContract(): Promise<void> {
	for (const cancellableHost of [false, true]) {
		const label = cancellableHost ? "public" : "private";
		const fileA = fakeFile(`${label}.md`);
		let nativeRequestCount = 0;
		let nativeSaveCount = 0;
		let persistedContent: string | null = null;
		const nativeRequestSave = function (this: Host): void {
			nativeRequestCount += 1;
			this.dirty = true;
		};
		const requestSave = cancellableHost
			? Object.assign(nativeRequestSave, { cancel() {} })
			: nativeRequestSave;
		const host = makeOwnHost({
			file: fileA,
			data: `content:${label}`,
			requestSave,
			save: async function () {
				if (!this.dirty) return;
				nativeSaveCount += 1;
				persistedContent = this.getViewData();
				this.dirty = false;
			},
		});
		const sessionId = `boot-${label}`;
		const { callbacks, facts } = callbacksFor({
			sessionId,
			generation: () => 4,
			saveOwnershipContext: () => ({
				sessionId,
				generation: 4,
				file: fileA,
				path: fileA.path,
				displayedPath: fileA.path,
			}),
			isSaveOwnershipContextCurrent: (context) =>
				context.sessionId === sessionId
				&& context.generation === 4
				&& context.file === host.file
				&& context.path === host.file?.path
				&& context.displayedPath === host.file?.path,
		});
		const result = installTextFileViewHandoffGuard(host, callbacks, {
			hostApiVersion: "1.13.4",
			requestSaveDelayMs: 60_000,
		});
		assert.equal(result.kind, "installed", label);
		if (result.kind !== "installed") continue;

		host.data = `content:${label}+edit`;
		host.requestSave();
		assert.equal(nativeRequestCount, 0, `${label}: native debounce remains bypassed`);
		assert.equal(host.dirty, true, `${label}: requestSave marks the host dirty synchronously`);
		assert.notEqual(result.guard.snapshot().pendingOwnedSave, null, label);
		await result.guard.flushOwnedSave();
		assert.equal(nativeSaveCount, 1, `${label}: dirty-aware native save publishes once`);
		assert.equal(persistedContent, `content:${label}+edit`);
		assert.equal(host.dirty, false, `${label}: native save clears dirty after publication`);
		assert.deepEqual(facts.capabilityLosses, []);
	}
}

async function retiredFlushRoutesThroughTheReplacementOwnedScheduler(): Promise<void> {
	const fileA = fakeFile("A.md");
	let nativeRequestCount = 0;
	let nativeSaveCount = 0;
	const host = makeOwnHost({
		file: fileA,
		requestSave: Object.assign(function (this: Host) {
			nativeRequestCount += 1;
			this.dirty = true;
		}, { cancel() {} }),
		save: async function () {
			nativeSaveCount += 1;
			this.dirty = false;
		},
	});
	const first = installTextFileViewHandoffGuard(host, callbacksFor().callbacks);
	assert.equal(first.kind, "installed");
	if (first.kind !== "installed") return;
	const retiredRequestSave = host.requestSave;
	const retiredFlush = (retiredRequestSave as unknown as { flush(): unknown }).flush;
	first.guard.restoreIfCurrent();

	const { callbacks, facts } = callbacksFor({
		sessionId: "boot-replacement-flush",
		generation: () => 9,
		saveOwnershipContext: () => ({
			sessionId: "boot-replacement-flush",
			generation: 9,
			file: fileA,
			path: fileA.path,
			displayedPath: fileA.path,
		}),
		isSaveOwnershipContextCurrent: (context) =>
			context.sessionId === "boot-replacement-flush"
			&& context.generation === 9
			&& context.file === host.file
			&& context.path === host.file?.path
			&& context.displayedPath === host.file?.path,
	});
	const replacement = installTextFileViewHandoffGuard(host, callbacks, {
		hostApiVersion: "1.13.4",
		requestSaveDelayMs: 60_000,
	});
	assert.equal(replacement.kind, "installed");
	if (replacement.kind !== "installed") return;
	host.requestSave();
	assert.notEqual(replacement.guard.snapshot().pendingOwnedSave, null);
	await Reflect.apply(retiredFlush, retiredRequestSave, []);
	assert.equal(replacement.guard.snapshot().pendingOwnedSave, null);
	assert.equal(nativeSaveCount, 1, "captured flush drains the replacement guard's owned job");
	assert.equal(nativeRequestCount, 0);
	assert.deepEqual(facts.capabilityLosses, []);
}

type PinnedHostWrite = Readonly<{
	file: TFile | null;
	path: string | null;
	content: string;
	clear: boolean;
}>;

function makeRetiringHost(input?: Readonly<{
	file?: TFile;
	content?: string;
	forcedSaveGate?: Deferred<void>;
	rejectForcedSave?: Error;
}>): Readonly<{ host: Host; writes: PinnedHostWrite[] }> {
	const file = input?.file ?? fakeFile("A.md");
	const content = input?.content ?? "content:A";
	const writes: PinnedHostWrite[] = [];
	const host = makeOwnHost({
		file,
		data: content,
		requestSave: function () {},
		onUnloadFile: async function (sourceFile) {
			assert.equal(sourceFile, this.file);
			await this.save(true);
		},
		onLoadFile: async function (targetFile) {
			this.file = targetFile;
			this.setViewData(`content:${targetFile.path}`, true);
		},
		save: async function (clear?: boolean) {
			const pinnedFile = this.file;
			const pinnedContent = this.getViewData();
			writes.push({
				file: pinnedFile,
				path: pinnedFile?.path ?? null,
				content: pinnedContent,
				clear: clear === true,
			});
			if (clear === true) {
				this.data = "";
				this.lastSavedData = null;
			}
			if (input?.forcedSaveGate) await input.forcedSaveGate.promise;
			if (input?.rejectForcedSave) throw input.rejectForcedSave;
		},
	});
	host.lastSavedData = content;
	return { host, writes };
}

async function sourceUnloadReceiptGatesTargetLoadOrdering(): Promise<void> {
	const fileA = fakeFile("A.md");
	const fileB = fakeFile("B.md");
	const fileC = fakeFile("C.md");

	{
		const writes: PinnedHostWrite[] = [];
		const host = makeOwnHost({
			file: fileA,
			data: "content:A",
			lastSavedData: "content:A",
			onUnloadFile: function () {
				void this.save(true);
			},
			onLoadFile: function (targetFile) {
				this.file = targetFile;
				this.setViewData(`content:${targetFile.path}`, true);
			},
			save: function (clear?: boolean) {
				writes.push({
					file: this.file,
					path: this.file?.path ?? null,
					content: this.getViewData(),
					clear: clear === true,
				});
				if (clear === true) {
					this.data = "";
					this.lastSavedData = null;
				}
				return Promise.resolve();
			},
		});
		const { callbacks, facts } = callbacksFor();
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;

		const unload = host.onUnloadFile(fileA);
		assert.equal(
			result.guard.snapshot().sourceUnload?.state,
			"settled",
			"a synchronous void host unload certifies its retired source before returning",
		);
		host.file = fileB;
		await host.onLoadFile(fileB);
		await unload;
		assert.equal(facts.tickets.length, 1, "the same-task target load consumes that receipt once");
		assert.deepEqual(facts.capabilityLosses, []);
		assert.deepEqual(writes, [{
			file: fileA,
			path: "A.md",
			content: "content:A",
			clear: true,
		}], "the synchronous host still pins and retires only A");
	}

	{
		const thenGetterError = new Error("host unload then getter failed");
		const host = makeOwnHost({
			file: fileA,
			data: "content:A",
			lastSavedData: "content:A",
			onUnloadFile: function () {
				void this.save(true);
				return Object.defineProperty({}, "then", {
					get() {
						throw thenGetterError;
					},
				});
			},
			save: function (clear?: boolean) {
				if (clear === true) {
					this.data = "";
					this.lastSavedData = null;
				}
				return Promise.resolve();
			},
		});
		const { callbacks } = callbacksFor();
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;

		await assert.rejects(
			host.onUnloadFile(fileA),
			(error: unknown) => error === thenGetterError,
		);
		assert.equal(
			result.guard.snapshot().sourceUnload?.state,
			"rejected",
			"a throwing then getter fails closed instead of stranding source unload",
		);
	}

	{
		const forcedSaveGate = deferred<void>();
		const { host, writes } = makeRetiringHost({ file: fileA, forcedSaveGate });
		const { callbacks, facts } = callbacksFor({
			saveOwnershipContext: () => ({
				sessionId: "boot-a",
				generation: 1,
				file: fileA,
				path: fileA.path,
				displayedPath: fileA.path,
			}),
			isSaveOwnershipContextCurrent: (context) =>
				context.sessionId === "boot-a"
				&& context.generation === 1
				&& context.file === fileA
				&& context.path === fileA.path
				&& context.displayedPath === fileA.path,
		});
		const result = installTextFileViewHandoffGuard(host, callbacks, {
			hostApiVersion: "1.13.4",
			requestSaveDelayMs: 60_000,
		});
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;

		host.requestSave();
		assert.notEqual(result.guard.snapshot().pendingOwnedSave, null);
		const pendingUnload = host.onUnloadFile(fileA);
		assert.equal(
			result.guard.snapshot().pendingOwnedSave,
			null,
			"source unload cancels the future save before forced retirement",
		);
		assert.deepEqual(writes, [{
			file: fileA,
			path: "A.md",
			content: "content:A",
			clear: true,
		}], "forced save pins exact source file and bytes before its first await");
		assert.deepEqual(result.guard.snapshot().sourceUnload && {
			file: result.guard.snapshot().sourceUnload?.file,
			path: result.guard.snapshot().sourceUnload?.path,
			state: result.guard.snapshot().sourceUnload?.state,
			forcedSaveObserved: result.guard.snapshot().sourceUnload?.forcedSaveObserved,
			cacheRetiredBeforeUnloadSettled:
				result.guard.snapshot().sourceUnload?.cacheRetiredBeforeUnloadSettled,
		}, {
			file: fileA,
			path: "A.md",
			state: "saving",
			forcedSaveObserved: true,
			cacheRetiredBeforeUnloadSettled: true,
		});
		host.requestSave();
		await host.save(false);
		assert.equal(
			result.guard.snapshot().pendingOwnedSave,
			null,
			"retired source cache cannot schedule a new future save",
		);
		assert.equal(
			writes.length,
			1,
			"only the exact forced retirement save may run while unload is held",
		);

		await host.onLoadFile(fileB);
		assert.equal(facts.tickets.length, 0, "load before unload settlement has no authority ticket");
		forcedSaveGate.resolve();
		await pendingUnload;
		assert.equal(facts.tickets.length, 0, "late unload settlement cannot bless an early load");
	}

	{
		const { host, writes } = makeRetiringHost({ file: fileA });
		const { callbacks, facts } = callbacksFor();
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		await host.onUnloadFile(fileA);
		const settled = result.guard.snapshot().sourceUnload;
		assert.equal(settled?.state, "settled");
		assert.equal(settled?.forcedSaveObserved, true);
		assert.equal(settled?.cacheRetiredBeforeUnloadSettled, true);
		await host.onLoadFile(fileB);
		assert.equal(facts.tickets.length, 1);
		const firstReceiptId = (
			facts.tickets[0] as ManagedHostSwitchTicket & { sourceUnloadReceiptId: string }
		).sourceUnloadReceiptId;
		assert.ok(firstReceiptId.length > 0);
		assert.equal(writes[0]?.file, fileA);
		assert.equal(writes[0]?.content, "content:A");

		host.lastSavedData = host.data;
		await host.onUnloadFile(fileB);
		await host.onLoadFile(fileC);
		assert.equal(facts.tickets.length, 2);
		const secondReceiptId = (
			facts.tickets[1] as ManagedHostSwitchTicket & { sourceUnloadReceiptId: string }
		).sourceUnloadReceiptId;
		assert.notEqual(secondReceiptId, firstReceiptId, "B-to-C cannot reuse A-to-B retirement");
		assert.equal(writes[1]?.file, fileB);
		assert.equal(writes[1]?.content, "content:B.md");

		await host.onLoadFile(fileA);
		assert.equal(facts.tickets.length, 2, "one retirement receipt authorizes one load entry only");
	}

	{
		const releaseBPresentation = deferred<void>();
		const writes: PinnedHostWrite[] = [];
		let generation = 1;
		let guard: TextFileViewHandoffGuard | null = null;
		const host = makeOwnHost({
			file: fileA,
			data: "content:A",
			onUnloadFile: async function () {
				await this.save(true);
			},
			onLoadFile: async function (targetFile) {
				this.file = targetFile;
				if (targetFile === fileB) await releaseBPresentation.promise;
				this.setViewData(`content:${targetFile.path}`, true);
			},
			save: async function (clear?: boolean) {
				writes.push({
					file: this.file,
					path: this.file?.path ?? null,
					content: this.getViewData(),
					clear: clear === true,
				});
				if (clear === true) {
					this.data = "";
					this.lastSavedData = null;
				}
			},
		});
		const { callbacks, facts } = callbacksFor({
			generation: () => generation,
			onLoad: (targetFile) => {
				guard?.beginBlockingHandoff({
					handoffGeneration: generation,
					sourceLineagePath: "A.md",
					targetPath: targetFile.path,
				});
			},
		});
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		guard = result.guard;

		await host.onUnloadFile(fileA);
		const pendingB = host.onLoadFile(fileB);
		assert.equal(host.file, fileB, "B file identity publishes before its target presentation");
		await host.onUnloadFile(fileB);
		assert.deepEqual(
			writes.map((write) => ({ file: write.file, content: write.content })),
			[{ file: fileA, content: "content:A" }],
			"unpresented B never saves the still-source-scoped host cache to B",
		);

		generation = 2;
		await host.onLoadFile(fileC);
		assert.deepEqual(
			facts.tickets.map((ticket) => ticket.targetFile),
			[fileB, fileC],
			"C receives a fresh ticket after exact unpresented-B retirement",
		);
		assert.notEqual(
			facts.tickets[0]?.sourceUnloadReceiptId,
			facts.tickets[1]?.sourceUnloadReceiptId,
			"C never reuses B's consumed source-retirement receipt",
		);
		assert.deepEqual(
			facts.setEntries.map((entry) => entry.ticket.targetFile),
			[fileC],
			"only C's exact clear load remains eligible for host association",
		);
		assert.equal(host.data, "content:C.md");
		assert.deepEqual(facts.capabilityLosses, []);
		void pendingB;
	}

	{
		const writes: PinnedHostWrite[] = [];
		let generation = 1;
		let guard: TextFileViewHandoffGuard | null = null;
		const host = makeOwnHost({
			file: fileA,
			data: "content:A",
			onUnloadFile: async function () {
				await this.save(true);
			},
			onLoadFile: async function (targetFile) {
				this.file = targetFile;
				this.setViewData(`content:${targetFile.path}`, true);
			},
			setViewData: function (content, _clear) {
				if (content !== "content:B.md") this.data = content;
			},
			save: async function (clear?: boolean) {
				writes.push({
					file: this.file,
					path: this.file?.path ?? null,
					content: this.getViewData(),
					clear: clear === true,
				});
				if (clear === true) {
					this.data = "";
					this.lastSavedData = null;
				}
			},
		});
		const { callbacks, facts } = callbacksFor({
			generation: () => generation,
			onLoad: (targetFile) => {
				guard?.beginBlockingHandoff({
					handoffGeneration: generation,
					sourceLineagePath: "A.md",
					targetPath: targetFile.path,
				});
			},
		});
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		guard = result.guard;

		await host.onUnloadFile(fileA);
		await host.onLoadFile(fileB);
		assert.equal(host.data, "", "fixture holds B target presentation after retiring A's cache");
		assert.equal(
			result.guard.snapshot().mode.kind,
			"blocking-handoff",
			"clear entry alone cannot prove the target presentation",
		);
		await host.onUnloadFile(fileB);
		assert.deepEqual(
			writes.map((write) => ({ file: write.file, content: write.content })),
			[{ file: fileA, content: "content:A" }],
			"clear-observed but unproven B cannot save the source-scoped cache to B",
		);

		generation = 2;
		await host.onLoadFile(fileC);
		assert.deepEqual(
			facts.tickets.map((ticket) => ticket.targetFile),
			[fileB, fileC],
			"unproven B rolls exact A retirement into one fresh C ticket",
		);
		assert.deepEqual(facts.capabilityLosses, []);
	}

	{
		const writes: PinnedHostWrite[] = [];
		let generation = 1;
		let guard: TextFileViewHandoffGuard | null = null;
		let activeTicket: ManagedHostSwitchTicket | null = null;
		let hostViewContent = "content:A";
		const host = makeOwnHost({
			file: fileA,
			data: "content:A",
			onUnloadFile: async function () {
				await this.save(true);
			},
			onLoadFile: async function (targetFile) {
				this.file = targetFile;
				this.setViewData(`content:${targetFile.path}`, true);
			},
			setViewData: function (content, _clear) {
				hostViewContent = content;
				this.data = content;
				this.lastSavedData = content;
				if (this.file !== fileB || activeTicket === null || guard === null) return;
				const ticket = activeTicket as ManagedHostSwitchTicket;
				assert.equal(guard.reportHostLoadCandidate(makeHostLoadCandidate({
					hostLoadTokenId: `host-load:${ticket.switchIntentSeq}`,
					ticket,
					view: host,
					incomingContent: content,
					runtimeViewDataBefore: "",
				})), true, "fixture reports the exact held B candidate");
				this.data = "";
			},
			save: async function (clear?: boolean) {
				writes.push({
					file: this.file,
					path: this.file?.path ?? null,
					content: this.getViewData(),
					clear: clear === true,
				});
				if (clear === true) {
					hostViewContent = "";
					this.data = "";
					this.lastSavedData = null;
				}
			},
		});
		host.getViewData = () => hostViewContent;
		const { callbacks, facts } = callbacksFor({
			generation: () => generation,
			onLoad: (targetFile) => {
				if (targetFile === fileC) generation = 2;
				guard?.beginBlockingHandoff({
					handoffGeneration: generation,
					sourceLineagePath: "A.md",
					targetPath: targetFile.path,
				});
			},
			onSet: (ticket) => {
				activeTicket = ticket;
			},
		});
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		guard = result.guard;

		await host.onUnloadFile(fileA);
		await host.onLoadFile(fileB);
		assert.equal(host.getViewData(), "content:B.md", "native host read may publish exact B before proof");
		assert.equal(host.data, "", "guard-owned runtime cache CAS retains the retired A cache state");
		assert.equal(facts.candidates.length, 1, "B has one exact held candidate");
		await host.onUnloadFile(fileB);
		assert.deepEqual(
			writes.map((write) => ({ file: write.file, content: write.content })),
			[{ file: fileA, content: "content:A" }],
			"exact held B cache is never saved under unproven B",
		);

		await host.onLoadFile(fileC);
		assert.deepEqual(
			facts.tickets.map((ticket) => ticket.targetFile),
			[fileB, fileC],
			"exact held B candidate rolls A retirement into a fresh C ticket",
		);
		assert.notEqual(
			facts.tickets[0]?.sourceUnloadReceiptId,
			facts.tickets[1]?.sourceUnloadReceiptId,
			"held-candidate rollover remains one-shot",
		);
		assert.deepEqual(facts.capabilityLosses, []);
	}

	{
		const releaseBPresentation = deferred<void>();
		const writes: PinnedHostWrite[] = [];
		let generation = 1;
		let guard: TextFileViewHandoffGuard | null = null;
		const host = makeOwnHost({
			file: fileA,
			data: "content:A",
			onUnloadFile: async function () {
				await this.save(true);
			},
			onLoadFile: async function (targetFile) {
				this.file = targetFile;
				if (targetFile === fileB) await releaseBPresentation.promise;
				this.setViewData(`content:${targetFile.path}`, true);
			},
			save: async function (clear?: boolean) {
				writes.push({
					file: this.file,
					path: this.file?.path ?? null,
					content: this.getViewData(),
					clear: clear === true,
				});
				if (clear === true) {
					this.data = "";
					this.lastSavedData = null;
				}
			},
		});
		const { callbacks, facts } = callbacksFor({
			generation: () => generation,
			onLoad: (targetFile) => {
				guard?.beginBlockingHandoff({
					handoffGeneration: generation,
					sourceLineagePath: "A.md",
					targetPath: targetFile.path,
				});
			},
		});
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		guard = result.guard;

		await host.onUnloadFile(fileA);
		const pendingB = host.onLoadFile(fileB);
		host.data = "unproven-source-drift";
		await host.onUnloadFile(fileB);
		assert.deepEqual(
			writes.map((write) => ({ file: write.file, content: write.content })),
			[{ file: fileA, content: "content:A" }],
			"proof drift still cannot fall back to saving source-scoped cache as B",
		);
		assert.deepEqual(
			facts.capabilityLosses,
			["source-unload-not-provable:unproven-target-source-lineage"],
			"unproven rollover loses managed capability without minting source authority",
		);
		generation = 2;
		await host.onLoadFile(fileC);
		assert.deepEqual(
			facts.tickets.map((ticket) => ticket.targetFile),
			[fileB],
			"proof-drifted C receives no target authority ticket",
		);
		void pendingB;
	}

	{
		const { host } = makeRetiringHost({ file: fileA });
		const { callbacks, facts } = callbacksFor();
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		await host.onUnloadFile(fileA);
		host.data = "input-after-unload";
		await host.onLoadFile(fileB);
		assert.equal(facts.tickets.length, 0, "input after retirement invalidates load authority");
	}

	{
		const { host, writes } = makeRetiringHost({ file: fileA });
		const { callbacks, facts } = callbacksFor();
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		await host.onUnloadFile(fileA);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.equal(result.guard.snapshot().sourceUnload?.state, "atomic-window-expired");
		await host.save(false);
		assert.equal(
			writes.length,
			1,
			"receipt expiry cannot authorize an empty-cache source save",
		);
		await host.onLoadFile(fileB);
		assert.equal(facts.tickets.length, 0, "an intervening task turn closes load authority");
	}

	{
		const rejected = new Error("forced save rejected");
		const { host } = makeRetiringHost({ file: fileA, rejectForcedSave: rejected });
		const { callbacks, facts } = callbacksFor();
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		await assert.rejects(host.onUnloadFile(fileA), (error: unknown) => error === rejected);
		assert.equal(result.guard.snapshot().sourceUnload?.state, "rejected");
		await host.onLoadFile(fileB);
		assert.equal(facts.tickets.length, 0, "rejected forced save cannot authorize target load");
	}

	{
		const host = makeOwnHost({
			file: fileB,
			data: "content:A",
			lastSavedData: "content:A",
			onUnloadFile: async function () {
				await this.save(true);
			},
			save: async function (clear?: boolean) {
				if (clear === true) {
					this.data = "";
					this.lastSavedData = null;
				}
			},
		});
		const { callbacks, facts } = callbacksFor();
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		await host.onUnloadFile(fileA);
		assert.deepEqual(
			facts.capabilityLosses,
			["source-unload-not-provable:source-content-unavailable"],
			"a host-selected target before unload entry reports the exact missing source proof",
		);
	}

	{
		const writes: PinnedHostWrite[] = [];
		const host = makeOwnHost({
			file: fileA,
			data: "content:A",
			lastSavedData: "content:A",
			onUnloadFile: async function () {
				await this.save(true);
			},
			onLoadFile: async function (targetFile) {
				this.file = targetFile;
				this.setViewData(`content:${targetFile.path}`, true);
			},
			save: async function (clear?: boolean) {
				const pinnedFile = this.file;
				const pinnedContent = this.getViewData();
				await Promise.resolve();
				writes.push({
					file: pinnedFile,
					path: pinnedFile?.path ?? null,
					content: pinnedContent,
					clear: clear === true,
				});
				if (clear === true) {
					this.data = "";
					this.lastSavedData = null;
				}
			},
		});
		const { callbacks, facts } = callbacksFor();
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		const pendingUnload = host.onUnloadFile(fileA);
		assert.equal(
			result.guard.snapshot().sourceUnload?.cacheRetiredBeforeUnloadSettled,
			false,
			"fixture retires the source cache only after the forced save yields",
		);
		await pendingUnload;
		assert.equal(
			result.guard.snapshot().sourceUnload?.state,
			"settled",
			"awaited cache retirement certifies the source before unload settles",
		);
		assert.equal(
			result.guard.snapshot().sourceUnload?.cacheRetiredBeforeUnloadSettled,
			true,
		);
		assert.deepEqual(facts.capabilityLosses, []);
		await host.onLoadFile(fileB);
		assert.equal(
			facts.tickets.length,
			1,
			"the immediately following target load consumes the awaited source receipt",
		);
		assert.deepEqual(writes, [{
			file: fileA,
			path: fileA.path,
			content: "content:A",
			clear: true,
		}]);
	}

	{
		const forcedSaveGate = deferred<void>();
		const host = makeOwnHost({
			file: fileA,
			data: "content:A",
			lastSavedData: "content:A",
			onUnloadFile: async function () {
				await this.save(true);
			},
			save: async function (clear?: boolean) {
				await forcedSaveGate.promise;
				if (clear === true) {
					this.data = "";
					this.lastSavedData = null;
				}
			},
		});
		const { callbacks, facts } = callbacksFor();
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;

		const pendingUnload = host.onUnloadFile(fileA);
		host.data = "content:A한";
		host.requestSave();
		forcedSaveGate.resolve();
		await pendingUnload;
		assert.equal(result.guard.snapshot().sourceUnload?.state, "rejected");
		assert.deepEqual(
			facts.capabilityLosses,
			["source-unload-not-provable:source-input-observed-before-settlement"],
			"input observed during awaited retirement cannot be hidden by a later cache clear",
		);
		await host.onLoadFile(fileB);
		assert.equal(facts.tickets.length, 0);
	}

	{
		const forcedSaveGate = deferred<void>();
		const { host, writes } = makeRetiringHost({ file: fileA, forcedSaveGate });
		const { callbacks, facts } = callbacksFor();
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		const pendingUnload = host.onUnloadFile(fileA);
		host.data = "content:A한";
		forcedSaveGate.resolve();
		await pendingUnload;
		assert.deepEqual(
			writes.map((write) => ({ file: write.file, content: write.content, clear: write.clear })),
			[
				{ file: fileA, content: "content:A", clear: true },
				{ file: fileA, content: "content:A한", clear: true },
			],
			"source input arriving during forced retirement is recertified by one exact source resave",
		);
		assert.deepEqual(facts.capabilityLosses, []);
		assert.equal(result.guard.snapshot().sourceUnload?.state, "settled");
		await host.onLoadFile(fileB);
		assert.equal(
			facts.tickets.length,
			1,
			"recertified source bytes authorize the immediately following target load once",
		);
	}

	{
		let saveCount = 0;
		const host = makeOwnHost({
			file: fileA,
			data: "content:A",
			lastSavedData: "content:A",
			onUnloadFile: async function () {
				await this.save(true);
			},
			save: async function (clear?: boolean) {
				saveCount += 1;
				if (clear === true) {
					const pinnedContent = this.data;
					this.data = "";
					this.lastSavedData = null;
					await Promise.resolve();
					this.data = `${pinnedContent}!`;
				}
			},
		});
		const { callbacks, facts } = callbacksFor();
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		await host.onUnloadFile(fileA);
		assert.equal(
			saveCount,
			4,
			"one forced save plus three recertification saves bound a continuously mutating host",
		);
		assert.deepEqual(
			facts.capabilityLosses,
			["source-unload-not-provable:source-content-changed-before-settlement"],
			"a host that never presents stable source bytes loses managed capability",
		);
		assert.equal(result.guard.snapshot().sourceUnload?.state, "rejected");
		await host.onLoadFile(fileB);
		assert.equal(facts.tickets.length, 0, "exhausted recertification authorizes no target load");
	}

	{
		const forcedSaveGate = deferred<void>();
		const host = makeOwnHost({
			file: fileA,
			data: "content:A",
			lastSavedData: "content:A",
			onUnloadFile: async function () {
				await this.save(true);
			},
			save: async function (clear?: boolean) {
				await forcedSaveGate.promise;
				if (clear === true) {
					this.data = "";
					this.lastSavedData = null;
				}
			},
		});
		const { callbacks, facts } = callbacksFor();
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		const pendingUnload = host.onUnloadFile(fileA);
		host.file = fileB;
		forcedSaveGate.resolve();
		await pendingUnload;
		assert.deepEqual(
			facts.capabilityLosses,
			["source-unload-not-provable:source-selection-changed-before-settlement"],
			"target selection during a deferred source save fails closed",
		);
		await host.onLoadFile(fileB);
		assert.equal(facts.tickets.length, 0, "selection-drifted retirement authorizes no target load");
	}

	{
		const writes: PinnedHostWrite[] = [];
		const host = makeOwnHost({
			file: fileA,
			data: "content:A",
			lastSavedData: "content:A",
			onUnloadFile: async function () {
				await this.save(true);
			},
			onLoadFile: async function (targetFile) {
				this.file = targetFile;
				this.setViewData(`content:${targetFile.path}`, true);
			},
			save: async function (clear?: boolean) {
				writes.push({
					file: this.file,
					path: this.file?.path ?? null,
					content: this.getViewData(),
					clear: clear === true,
				});
			},
		});
		const { callbacks, facts } = callbacksFor();
		const result = installTextFileViewHandoffGuard(host, callbacks);
		assert.equal(result.kind, "installed");
		if (result.kind !== "installed") return;
		await host.onUnloadFile(fileA);
		assert.equal(
			result.guard.snapshot().sourceUnload?.state,
			"settled",
			"an exact unchanged source presentation can remain live until target load",
		);
		assert.equal(
			result.guard.snapshot().sourceUnload?.cacheRetiredBeforeUnloadSettled,
			false,
		);
		assert.deepEqual(facts.capabilityLosses, []);
		host.file = fileB;
		await host.save(false);
		assert.equal(
			writes.length,
			1,
			"the unconsumed receipt blocks stale A cache from being saved under B",
		);
		await host.onLoadFile(fileB);
		assert.equal(
			facts.tickets.length,
			1,
			"the exact source presentation authorizes only the immediately following target load",
		);
	}
}

async function snapshotIsDefensive(): Promise<void> {
	const started = deferred<void>();
	const released = deferred<void>();
	const host = makeOwnHost({
		save: async function () {
			started.resolve();
			await released.promise;
		},
	});
	const result = installTextFileViewHandoffGuard(host, callbacksFor().callbacks);
	assert.equal(result.kind, "installed");
	if (result.kind !== "installed") return;
	const pending = host.save();
	await started.promise;
	const snapshot = result.guard.snapshot();
	assert.equal(snapshot.leafId, "leaf-a");
	assert.equal(snapshot.view, host);
	assert.equal(snapshot.installedRequestSave, host.requestSave);
	assert.equal(snapshot.installedSave, host.save);
	const snapshotEntry = snapshot.inFlight.values().next().value as { startedAt: number } | undefined;
	if (snapshotEntry !== undefined) snapshotEntry.startedAt = 0;
	(snapshot.inFlight as Map<number, unknown>).clear();
	const mutableMode = snapshot.mode as { kind: string };
	mutableMode.kind = "blocking-handoff";
	const next = result.guard.snapshot();
	assert.equal(next.inFlight.size, 1);
	assert.notEqual(next.inFlight.values().next().value?.startedAt, 0);
	assert.equal(next.mode.kind, "pass-through");
	released.resolve();
	await pending;
}

function saveGuardModeAliasIsModulePrivate(): void {
	const source = readFileSync(
		new URL("../src/sync/textFileViewHandoffGuard.ts", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(source, /export\s+type\s+ManagedViewSaveGuardMode\b/);
}

await ownDescriptorRestoreAndMethodSemantics();
await inheritedRestoreAndPrototypeSafety();
await asyncDelegationFramesPreserveBridgeTailsAndIdentity();
await concurrentRetiredLoadBridgesPreserveClearCapability();
await distinctSaveDelegationLanesDoNotStealFrames();
await concurrentAsyncSaveDelegationLanesFailClosed();
await blockingHandoffRevokesPendingSaveDelegationFrames();
await retiredLoadAndSetRouteThroughReplacementGuard();
await copiedWrappersStayBoundToManagedView();
await exactHostLoadDispatchCertificateIsSynchronousAndExact();
await ticketOrderingAndClearAssociation();
await candidateRoutesInsideOriginalClearBoundary();
await associatedHostLoadLifecycleRoutesExactFacts();
await rejectedHostLoadDiscardsQueuedCompletion();
await rejectedNoClearLoadAllowsMultipleCleanRetries();
await fulfilledNoClearLoadLosesCapabilityUntilTeardown();
await unretiredOverlappingLoadsRemainAuthorityInert();
await staleLoadBecomesCallbackInert();
await overlappingLoadsFailClosed({ label: "same generation", advanceGeneration: false });
await overlappingLoadsFailClosed({ label: "newer generation", advanceGeneration: true });
await delayedClearAfterSettlementPoisonsTheConcurrentRetryOnly();
await loadEntryPathIsImmutableAcrossTFileRename();
await callbackCanBlockBeforeTicketReturn();
await saveCancellationSuppressionProofAndPinning();
await ownedFutureSchedulersPreserveTheSynchronousDirtyContract();
await thirdPartyAndInertSafety();
await restoredViewCanBeInstalledAgain();
await retiredSaveWrappersRouteThroughTheReplacementGuard();
unsupportedHostsAreAtomic();
await testedPrivateHostUsesOwnedFutureScheduler();
await testedPublicHostUsesOwnedFutureSchedulerAndTeardownDrain();
await retiredFlushRoutesThroughTheReplacementOwnedScheduler();
await sourceUnloadReceiptGatesTargetLoadOrdering();
await snapshotIsDefensive();
saveGuardModeAliasIsModulePrivate();

console.log("text-file-view-handoff-guard: all tests passed");
