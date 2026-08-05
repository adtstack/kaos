import {
	Annotation,
	EditorSelection,
	EditorState,
	Prec,
	StateEffect,
	StateField,
	Transaction,
	type Extension,
} from "@codemirror/state";
import { history, undoDepth } from "@codemirror/commands";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { TFile, TextFileView } from "obsidian";
import type { ManagedLeafSession } from "../src/sync/editorHandoffState";
import {
	acceptedHostLoad,
	handoffGateClosedFacet,
	handoffGateCompartment,
	installCodeMirrorHandoffGuard,
	type CodeMirrorHandoffContext,
} from "../src/sync/codeMirrorHandoffGuard";

type FullInputStartReservation = NonNullable<ManagedLeafSession["pendingInputStartReservation"]>;

type BrowserResult = Readonly<{
	passed: number;
	failed: number;
	failures: readonly string[];
}>;

type AcceptanceProbe = Readonly<{
	kind: string;
	notification?: "candidate" | "completion";
	receipt?: unknown;
}>;

type DeferredMeasure = Readonly<{
	read(view: EditorView): unknown;
	write?(measure: unknown, view: EditorView): void;
}>;

declare global {
	interface Window {
		__KAOS_TEST_RESULT__?: BrowserResult;
		__KAOS_TEST_DONE__?: Promise<BrowserResult>;
	}
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: unknown, message: string): asserts condition {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed += 1;
		return;
	}
	console.error(`  FAIL  ${message}`);
	failed += 1;
	failures.push(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
	assert(Object.is(actual, expected), `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

async function probeAcceptance(value: Promise<unknown> | undefined): Promise<AcceptanceProbe> {
	if (value === undefined) return { kind: "missing" };
	try {
		return await value as AcceptanceProbe;
	} catch {
		return { kind: "threw" };
	}
}

function file(path: string): TFile {
	return { path } as TFile;
}

function runtimeView(path: string, data: string): TextFileView {
	return {
		file: file(path),
		data,
		leaf: { id: "leaf-1" },
	} as unknown as TextFileView;
}

type Fixture = ReturnType<typeof fixture>;

function fixture(
	initial = "source A",
	associated = true,
	historySeeded = true,
	extraExtensions: readonly Extension[] = [],
	beforeGuardInstall: ((view: EditorView) => void) | null = null,
) {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const observedDocuments: string[] = [];
	const observedTransactions: Transaction[] = [];
	const routedTransactions: Transaction[] = [];
	const candidates: unknown[] = [];
	const completions: unknown[] = [];
	const hostLoadCaptureRejections: string[] = [];
	const samePathCompletions: unknown[] = [];
	const samePathRejections: unknown[] = [];
	const nativeHistoryAdvances: Array<Readonly<{
		cm: EditorView;
		startState: EditorState;
		finalState: EditorState;
		nativeHistoryEpochBefore: number;
		nativeHistoryEpochAfter: number;
	}>> = [];
	const unresolvedInputTerminals: Array<Readonly<{
		reservation: FullInputStartReservation;
		reason: "composition-unresolved" | "spanning-input";
	}>> = [];
	const arbitraryAnnotation = Annotation.define<string>();
	const arbitraryEffect = StateEffect.define<string>();
	const voidEffect = StateEffect.define<void>();
	const resetHistory = StateEffect.define<boolean>();
	let historyResetBehavior: "apply" | "noop" = "apply";
	const historyField = StateField.define<Readonly<{
		marker: "source-A" | "empty" | "target-reset";
		resetEpoch: number;
		resetTransaction: Transaction | null;
		clearedSourceMarker: boolean;
	}>>({
		create: () => ({
			marker: historySeeded ? "source-A" : "empty",
			resetEpoch: 0,
			resetTransaction: null,
			clearedSourceMarker: false,
		}),
		update(value, transaction) {
			if (!transaction.effects.some((effect) => effect.is(resetHistory))) return value;
			if (historyResetBehavior === "noop") return value;
			return {
				marker: "target-reset",
				resetEpoch: value.resetEpoch + 1,
				resetTransaction: transaction,
				clearedSourceMarker: value.marker === "source-A",
			};
		},
	});
	const sentinel = ViewPlugin.define(() => ({
		update(update): void {
			for (const transaction of update.transactions) {
				observedTransactions.push(transaction);
				if (transaction.docChanged) observedDocuments.push(transaction.newDoc.toString());
			}
		},
	}));
	const extensions: Extension[] = [history(), historyField, sentinel, ...extraExtensions];
	let beforeRoute: ((transactions: readonly Transaction[], target: EditorView) => void) | null = null;
	let afterRoute: ((transactions: readonly Transaction[], target: EditorView) => void) | null = null;
	let historySettlementObserved = true;
	let candidateDelivery: "acknowledge" | "reject" | "throw" = "acknowledge";
	let completionDelivery: "acknowledge" | "reject" | "throw" = "acknowledge";
	let candidateDeliveryHook: ((candidate: unknown, depth: number) => void) | null = null;
	let completionDeliveryHook: ((receipt: unknown, depth: number) => void) | null = null;
	let candidateCallbackDepth = 0;
	let completionCallbackDepth = 0;
	let candidateCallbackMaxDepth = 0;
	let completionCallbackMaxDepth = 0;
	let reservationOverride: Partial<FullInputStartReservation> | null | undefined;
	let exactHostStateReplacementDepth = 0;
	let exactHostPostDelegationDepth = 0;
	let bypassGuardUpdateBoundary = false;
	let rawUpdate: EditorView["update"] | null = null;
	const view = new EditorView({
		parent,
		state: EditorState.create({ doc: initial, extensions }),
		dispatchTransactions(transactions, target): void {
			beforeRoute?.(transactions, target);
			routedTransactions.push(...transactions);
			if (bypassGuardUpdateBoundary && rawUpdate !== null) {
				Reflect.apply(rawUpdate, target, [transactions]);
			} else {
				target.update(transactions);
			}
			afterRoute?.(transactions, target);
		},
	});
	const originalDispatch = view.dispatch;
	const originalUpdate = view.update;
	rawUpdate = originalUpdate;
	const originalSetState = view.setState;
	const originalDestroy = view.destroy;
	const host = runtimeView("B.md", initial);
	const sourceFile = file("A.md");
	const sourceFileId = "file-a";
	let eventOrderSeq = 0;
	let switchIntentSeq = 1;
	let generation = 1;
	let targetPath = "B.md";
	let targetFile = host.file ?? file(targetPath);
	let context: CodeMirrorHandoffContext | null = associated
		? {
			kind: "same-path",
			sessionId: "session-1",
			leafId: "leaf-1",
			handoffGeneration: generation,
			path: "A.md",
		}
		: null;
	const reservations: FullInputStartReservation[] = [];
	let nextId = 1;
	beforeGuardInstall?.(view);
	const installed = installCodeMirrorHandoffGuard(view, {
		getCurrentContext: () => context,
		reserveManagedLeafInputStart(input) {
			if (reservationOverride === null) return null;
			eventOrderSeq += 1;
			const sourceAuthorityPathAtStart = context?.kind === "handoff"
				? context.fromPath
				: context?.path ?? null;
			const reservation: FullInputStartReservation = {
				inputStartSeq: eventOrderSeq,
				inputStartedUnderSwitchSeq: context?.kind === "handoff" ? switchIntentSeq : null,
				inputEpoch: input.inputEpoch,
				compositionEpoch: input.compositionEpoch,
				handoffGenerationAtStart: context?.handoffGeneration ?? input.expectedGeneration,
				sourceAuthorityPathAtStart,
				sourceFileAtStart: sourceAuthorityPathAtStart === sourceFile.path ? sourceFile : null,
				sourceFileIdAtStart: sourceAuthorityPathAtStart === sourceFile.path ? sourceFileId : null,
				sourceDocumentAtStart: view.state.doc,
				targetPathAtStart: context?.kind === "handoff" ? context.targetPath : null,
				targetFileAtStart: context?.kind === "handoff" ? context.targetFile : null,
				...reservationOverride,
			};
			reservations.push(reservation);
			return reservation;
		},
		onHostLoadCandidate(candidate) {
			candidateCallbackDepth += 1;
			candidateCallbackMaxDepth = Math.max(candidateCallbackMaxDepth, candidateCallbackDepth);
			try {
				candidates.push(candidate);
				candidateDeliveryHook?.(candidate, candidateCallbackDepth);
				if (candidateDelivery === "throw") throw new Error("candidate-delivery-failed");
				return candidateDelivery === "acknowledge";
			} finally {
				candidateCallbackDepth -= 1;
			}
		},
		onHostLoadCompleted(receipt) {
			completionCallbackDepth += 1;
			completionCallbackMaxDepth = Math.max(completionCallbackMaxDepth, completionCallbackDepth);
			try {
				completions.push(receipt);
				completionDeliveryHook?.(receipt, completionCallbackDepth);
				if (completionDelivery === "throw") throw new Error("completion-delivery-failed");
				return completionDelivery === "acknowledge";
			} finally {
				completionCallbackDepth -= 1;
			}
		},
		onHostLoadCaptureRejected(reason) {
			hostLoadCaptureRejections.push(reason);
		},
		isExactHostStateReplacement(targetState, input) {
			return exactHostStateReplacementDepth === 1
				&& context?.kind === "handoff"
				&& input.sessionId === context.sessionId
				&& input.leafId === context.leafId
				&& input.handoffGeneration === context.handoffGeneration
				&& input.switchIntentSeq === context.switchIntentSeq
				&& input.sourceUnloadReceiptId === context.sourceUnloadReceiptId
				&& input.targetPath === context.targetPath
				&& input.targetFile === context.targetFile
				&& input.runtimeView === context.runtimeView
				&& targetState.doc.toString() === input.incomingContent;
		},
		isExactHostLoadDispatchActive(candidate) {
			return exactHostPostDelegationDepth === 1
				&& context?.kind === "handoff"
				&& candidate.sessionId === context.sessionId
				&& candidate.leafId === context.leafId
				&& candidate.handoffGeneration === context.handoffGeneration
				&& candidate.switchIntentSeq === context.switchIntentSeq
				&& candidate.sourceUnloadReceiptId === context.sourceUnloadReceiptId
				&& candidate.targetPathAtDispatch === context.targetPath
				&& candidate.runtimeView === context.runtimeView;
		},
		onUnresolvedInputTerminal(input) {
			unresolvedInputTerminals.push(input as typeof unresolvedInputTerminals[number]);
			return true;
		},
		onSamePathInputCompleted(completion) {
			samePathCompletions.push(completion);
			return true;
		},
		onSamePathInputRejected(rejection) {
			samePathRejections.push(rejection);
			return true;
		},
		onNativeHistoryAdvanced(advance) {
			nativeHistoryAdvances.push(advance);
		},
		isNativeHistoryReset(transaction) {
			return transaction.effects.some((effect) => effect.is(resetHistory));
		},
		observeNativeHistoryReset(target, transaction) {
			const evidence = target.state.field(historyField);
			return historySettlementObserved
				&& transaction.effects.some((effect) => effect.is(resetHistory))
				&& evidence.marker === "target-reset"
				&& evidence.resetEpoch === 1
				&& evidence.resetTransaction === transaction
				&& evidence.clearedSourceMarker;
		},
		createId: (prefix) => `${prefix}-${nextId++}`,
	});
	assert(installed.kind === "installed", "real EditorView installs the handoff guard");
	const guard = installed.kind === "installed" ? installed.guard : null;
	observedDocuments.length = 0;
	observedTransactions.length = 0;
	routedTransactions.length = 0;
	return {
		view,
		originalDispatch,
		originalUpdate,
		originalSetState,
		originalDestroy,
		host,
		sourceFile,
		sourceFileId,
		guard,
		parent,
		extensions,
		historyField,
		resetHistory,
		arbitraryAnnotation,
		arbitraryEffect,
		voidEffect,
		observedDocuments,
		observedTransactions,
		routedTransactions,
		candidates,
		completions,
		hostLoadCaptureRejections,
		samePathCompletions,
		samePathRejections,
		nativeHistoryAdvances,
		unresolvedInputTerminals,
		reservations,
		setContext(next: CodeMirrorHandoffContext | null) {
			context = next;
		},
		withExactHostStateReplacement<T>(replace: () => T): T {
			exactHostStateReplacementDepth += 1;
			try {
				return replace();
			} finally {
				exactHostStateReplacementDepth -= 1;
			}
		},
		withExactHostPostDelegation<T>(certify: () => T): T {
			exactHostPostDelegationDepth += 1;
			try {
				return certify();
			} finally {
				exactHostPostDelegationDepth -= 1;
			}
		},
		selectHandoff(path = targetPath): Extract<CodeMirrorHandoffContext, { kind: "handoff" }> {
			targetPath = path;
			targetFile = file(path);
			host.file = targetFile;
			generation += 1;
			eventOrderSeq += 1;
			switchIntentSeq = eventOrderSeq;
			context = {
				kind: "handoff",
				sessionId: "session-1",
				leafId: "leaf-1",
				handoffGeneration: generation,
				switchIntentSeq,
				sourceUnloadReceiptId: `source-unload:${switchIntentSeq}`,
				fromPath: "A.md",
				fromFileId: "file-a",
				targetPath,
				targetFile,
				runtimeView: host,
				bindingEpoch: 7,
				editorRevisionBefore: 0,
			};
			return context;
		},
		beginHandoff(path = targetPath): void {
			this.selectHandoff(path);
			assert(guard?.refreshGate() === true, "handoff gate reconfigures after the current context changes");
		},
		setRouteHooks(input: Readonly<{
			before?: (transactions: readonly Transaction[], target: EditorView) => void;
			after?: (transactions: readonly Transaction[], target: EditorView) => void;
		}>): void {
			beforeRoute = input.before ?? null;
			afterRoute = input.after ?? null;
		},
		setBypassGuardUpdateBoundary(value: boolean): void {
			bypassGuardUpdateBoundary = value;
		},
		setHistorySettlementObserved(value: boolean): void {
			historySettlementObserved = value;
		},
		setHistoryResetBehavior(value: "apply" | "noop"): void {
			historyResetBehavior = value;
		},
		setCandidateDelivery(value: "acknowledge" | "reject" | "throw"): void {
			candidateDelivery = value;
		},
		setCompletionDelivery(value: "acknowledge" | "reject" | "throw"): void {
			completionDelivery = value;
		},
		setCandidateDeliveryHook(value: ((candidate: unknown, depth: number) => void) | null): void {
			candidateDeliveryHook = value;
		},
		setCompletionDeliveryHook(value: ((receipt: unknown, depth: number) => void) | null): void {
			completionDeliveryHook = value;
		},
		candidateCallbackMaxDepth(): number {
			return candidateCallbackMaxDepth;
		},
		completionCallbackMaxDepth(): number {
			return completionCallbackMaxDepth;
		},
		setReservationOverride(value: Partial<FullInputStartReservation> | null): void {
			reservationOverride = value;
		},
		currentHandoff(): Extract<CodeMirrorHandoffContext, { kind: "handoff" }> {
			assert(context?.kind === "handoff", "fixture has a current handoff");
			return context;
		},
	};
}

function beginRejectBeforeTargetHandoff(
	item: Fixture,
	path = "B.md",
): Extract<CodeMirrorHandoffContext, { kind: "handoff" }> {
	const selected = item.selectHandoff(path);
	item.setContext({ ...selected, inputPolicy: "reject-before-target" });
	assert(
		item.guard?.refreshGate() === true,
		"reject-before-target handoff gate reconfigures after target selection",
	);
	return item.currentHandoff();
}

function destroy(item: Fixture): void {
	item.guard?.restoreIfCurrent();
	item.view.destroy();
	item.parent.remove();
}

function holdClearHostLoad(
	item: Fixture,
	hostLoadTokenId: string,
	incomingContent = "certified B",
): Readonly<{
	context: Extract<CodeMirrorHandoffContext, { kind: "handoff" }>;
	transaction: Transaction;
	candidate: unknown;
}> {
	const context = item.currentHandoff();
	assert(item.guard?.armHostLoad({
		hostLoadTokenId,
		...context,
		incomingContent,
	}) === true, `${hostLoadTokenId} arms the exact current host load`);
	const transaction = item.view.state.update({
		changes: { from: 0, to: item.view.state.doc.length, insert: incomingContent },
		effects: item.resetHistory.of(true),
		filter: false,
	});
	item.host.data = incomingContent;
	item.view.dispatch(transaction);
	const candidate = item.candidates[item.candidates.length - 1];
	assert(candidate !== undefined, `${hostLoadTokenId} produces a held candidate`);
	return { context, transaction, candidate };
}

function holdStateHostLoad(
	item: Fixture,
	hostLoadTokenId: string,
	incomingContent = "B bytes",
): unknown {
	const context = item.currentHandoff();
	assert(item.guard?.armHostLoad({
		hostLoadTokenId,
		...context,
		incomingContent,
	}) === true, `${hostLoadTokenId} arms the exact host state replacement`);
	item.host.data = incomingContent;
	item.withExactHostStateReplacement(() => {
		item.view.setState(EditorState.create({
			doc: incomingContent,
			extensions: item.extensions,
		}));
	});
	const candidate = item.candidates[item.candidates.length - 1];
	assert(candidate !== undefined, `${hostLoadTokenId} retains one host candidate`);
	equal(
		item.withExactHostPostDelegation(() =>
			item.guard?.certifyHostLoadPostDelegation(hostLoadTokenId)),
		true,
		`${hostLoadTokenId} certifies the exact synchronous host tail`,
	);
	return candidate;
}

function completeReplayEligibleComposition(item: Fixture, data = "한"): void {
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", {
		bubbles: true,
		data: "",
	}));
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", {
		bubbles: true,
		data,
	}));
	item.view.dispatch(item.view.state.update({
		changes: { from: item.view.state.doc.length, insert: data },
		selection: EditorSelection.cursor(item.view.state.doc.length + data.length),
		userEvent: "input.type.compose",
		filter: false,
	}));
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", {
		bubbles: true,
		data,
	}));
}

function deferMeasurements(item: Fixture): Readonly<{
	request(): DeferredMeasure | null;
	restore(): void;
}> {
	const descriptor = Object.getOwnPropertyDescriptor(item.view, "requestMeasure");
	let request: DeferredMeasure | null = null;
	Object.defineProperty(item.view, "requestMeasure", {
		configurable: true,
		writable: true,
		value(next: DeferredMeasure): void {
			request = next;
		},
	});
	return {
		request: () => request,
		restore(): void {
			if (descriptor === undefined) Reflect.deleteProperty(item.view, "requestMeasure");
			else Object.defineProperty(item.view, "requestMeasure", descriptor);
		},
	};
}

function runDeferredMeasure(request: DeferredMeasure | null, view: EditorView): void {
	if (request === null) return;
	try {
		const measure = request.read(view);
		request.write?.(measure, view);
	} catch {
		// A destroyed view may reject a deliberately late synthetic callback.
	}
}

async function runBrowserSuite(): Promise<BrowserResult> {
	console.log("\n--- Contract Test 1: unassociated mutations fail closed ---");
	{
		const item = fixture("source A", false);
		item.view.dispatch(item.view.state.update({
			changes: { from: 0, to: item.view.state.doc.length, insert: "foreign" },
			filter: false,
		}));
		equal(item.view.state.doc.toString(), "source A", "an unassociated transaction cannot replace the editor document");
		equal(item.observedDocuments.length, 0, "an unassociated replacement is never exposed to observers");
		destroy(item);
	}

	console.log("\n--- Contract Test 2: a target-less fence rejects the switch gap ---");
	{
		const item = fixture("source A");
		const fence = item.guard?.prepareTargetSelectionFence("unload:no-reservation");
		assert(fence !== null && fence !== undefined, "a source with no live reservation installs one exact target-less fence");
		assert(item.guard?.isTargetSelectionFenceCurrent(fence) === true, "the target-less fence owns the unchanged source editor");
		const fresh = new InputEvent("beforeinput", {
			bubbles: true,
			cancelable: true,
			inputType: "insertText",
			data: "x",
		});
		item.view.contentDOM.dispatchEvent(fresh);
		equal(fresh.defaultPrevented, true, "fresh native input is rejected before the target identity exists");
		equal(item.reservations.length, 0, "the target-less gap never creates a replay reservation");
		item.view.dispatch(item.view.state.update({
			changes: { from: item.view.state.doc.length, insert: "x" },
			userEvent: "input.type",
			filter: false,
		}));
		equal(item.view.state.doc.toString(), "source A", "a foreign transaction cannot cross the target-less fence");
		assert(item.guard?.releaseTargetSelectionFence(fence) === true, "an unchanged source-side fence can be released exactly");
		destroy(item);
	}

	console.log("\n--- Contract Test 3: one reserved ordinary source input drains exactly once ---");
	{
		const item = fixture("source A");
		item.view.dispatch({ selection: EditorSelection.cursor(item.view.state.doc.length) });
		const input = new InputEvent("beforeinput", {
			bubbles: true,
			cancelable: true,
			inputType: "insertText",
			data: "x",
		});
		item.view.contentDOM.dispatchEvent(input);
		const reservation = item.reservations[0];
		assert(reservation !== undefined, "ordinary source input obtains one reducer reservation");
		assert(item.guard?.beginSourceUnloadDrain("unload:ordinary", reservation) === true, "unload adopts the exact pending ordinary lane");
		const fresh = new InputEvent("beforeinput", {
			bubbles: true,
			cancelable: true,
			inputType: "insertText",
			data: "y",
		});
		item.view.contentDOM.dispatchEvent(fresh);
		equal(fresh.defaultPrevented, true, "fresh input is rejected while the source lane drains");
		equal(item.reservations.length, 1, "no second reservation is created during source drain");
		item.view.dispatch(item.view.state.update({
			changes: { from: item.view.state.doc.length, insert: "y" },
			selection: EditorSelection.cursor(item.view.state.doc.length + 1),
			userEvent: "input.type",
			filter: false,
		}));
		equal(item.view.state.doc.toString(), "source A", "a fresh userEvent transaction cannot borrow the old x reservation");
		equal(item.view.contentDOM.textContent, "source A", "fresh drain-time bytes never reach the DOM projection");
		equal(item.observedDocuments.length, 0, "fresh drain-time bytes are rejected before editor observers");
		equal(item.samePathRejections.length, 0, "fresh bytes are rejected pre-apply instead of terminalizing after mutation");
		item.view.dispatch(item.view.state.update({
			changes: { from: 0, insert: "x" },
			selection: EditorSelection.cursor(1),
			userEvent: "input.type",
			filter: false,
		}));
		equal(item.view.state.doc.toString(), "source A", "matching x bytes at the wrong range cannot borrow the reservation");
		equal(item.observedDocuments.length, 0, "wrong-range x bytes are rejected before editor observers");
		item.view.dispatch(item.view.state.update({
			changes: { from: item.view.state.doc.length, insert: "x" },
			selection: EditorSelection.cursor(item.view.state.doc.length),
			userEvent: "input.type",
			filter: false,
		}));
		equal(item.view.state.doc.toString(), "source A", "matching x bytes with the wrong result cursor cannot borrow the reservation");
		equal(item.observedDocuments.length, 0, "wrong-selection x bytes are rejected before editor observers");
		item.view.dispatch(item.view.state.update({
			changes: { from: item.view.state.doc.length, insert: "foreign" },
			annotations: Transaction.remote.of(true),
			filter: false,
		}));
		equal(item.view.state.doc.toString(), "source A", "a foreign document transaction is rejected while the exact source lane drains");
		equal(item.observedDocuments.length, 0, "foreign drain-time bytes never reach editor observers or DOM projection");
		item.view.dispatch(item.view.state.update({
			changes: { from: item.view.state.doc.length, insert: "x" },
			selection: EditorSelection.cursor(item.view.state.doc.length + 1),
			userEvent: "input.type",
			filter: false,
		}));
		equal(item.view.state.doc.toString(), "source Ax", "the already-reserved source transaction is allowed to finish");
		equal(item.samePathCompletions.length, 1, "the exact source completion is acknowledged once");
		const fence = item.guard?.prepareTargetSelectionFence("unload:ordinary", reservation);
		assert(fence !== null && fence !== undefined, "completion converts the source drain into a target-less fence");
		assert(item.guard?.isTargetSelectionFenceCurrent(fence) === true, "the converted fence remains exact after source completion");
		assert(item.guard?.releaseTargetSelectionFence(fence) === true, "the exact converted fence can be released on abort");
		destroy(item);
	}

	console.log("\n--- Contract Test 4: one reserved IME source input drains without replay ---");
	{
		const item = fixture("source A");
		item.view.dispatch({ selection: EditorSelection.cursor(item.view.state.doc.length) });
		item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", {
			bubbles: true,
			cancelable: true,
			data: "",
		}));
		const reservation = item.reservations[0];
		assert(reservation !== undefined, "IME start obtains one reducer reservation");
		assert(item.guard?.beginSourceUnloadDrain("unload:ime", reservation) === true, "unload adopts the exact active IME lane");
		const fresh = new CompositionEvent("compositionstart", {
			bubbles: true,
			cancelable: true,
			data: "새",
		});
		item.view.contentDOM.dispatchEvent(fresh);
		equal(fresh.defaultPrevented, true, "a fresh composition cannot start during source drain");
		item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", {
			bubbles: true,
			data: "한",
		}));
		item.view.dispatch(item.view.state.update({
			changes: { from: item.view.state.doc.length, insert: "한" },
			selection: EditorSelection.cursor(item.view.state.doc.length + 1),
			userEvent: "input.type.compose",
			filter: false,
		}));
		item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", {
			bubbles: true,
			data: "한",
		}));
		equal(item.view.state.doc.toString(), "source A한", "the exact active IME lane finishes on source A");
		equal(item.samePathCompletions.length, 1, "IME completion is acknowledged once without replay");
		const fence = item.guard?.prepareTargetSelectionFence("unload:ime", reservation);
		assert(fence !== null && fence !== undefined, "IME completion converts to one target-less fence");
		assert(item.guard?.releaseTargetSelectionFence(fence) === true, "the IME fence has one exact abort release");
		destroy(item);
	}

	console.log("\n--- Contract Test 5: the held target is presented once, locally ---");
	{
		const item = fixture("source A");
		item.beginHandoff("B.md");
		const held = holdClearHostLoad(item, "host-load:B", "target B");
		equal(item.view.state.doc.toString(), "source A", "host target bytes remain held until local presentation");
		const presented = item.guard?.presentHeldHostLoadLocally({
			candidate: held.candidate as Parameters<NonNullable<typeof item.guard>["presentHeldHostLoadLocally"]>[0]["candidate"],
			localPresentationId: "local:B:1",
		});
		equal(presented?.kind, "accepted", "the exact held target is committed by the local presenter");
		equal(item.view.state.doc.toString(), "target B", "the target document becomes visible after acceptance");
		equal(item.completions.length, 1, "local presentation publishes one completion receipt");
		const duplicate = item.guard?.presentHeldHostLoadLocally({
			candidate: held.candidate as Parameters<NonNullable<typeof item.guard>["presentHeldHostLoadLocally"]>[0]["candidate"],
			localPresentationId: "local:B:2",
		});
		assert(duplicate?.kind !== "accepted", "the same held candidate cannot be presented twice");
		destroy(item);
	}

	console.log("\n--- Contract Test 6: an unarmed target projection cannot poison the source host cache ---");
	{
		const item = fixture("source A");
		beginRejectBeforeTargetHandoff(item, "B.md");
		const descriptorBefore = Object.getOwnPropertyDescriptor(item.host, "data");
		item.host.data = "external B before certified load";
		item.view.dispatch(item.view.state.update({
			changes: {
				from: 0,
				to: item.view.state.doc.length,
				insert: "external B before certified load",
			},
			filter: false,
		}));
		equal(
			item.view.state.doc.toString(),
			"source A",
			"the unarmed full replacement remains outside CodeMirror",
		);
		equal(
			item.host.data,
			"source A",
			"the rejected unarmed projection restores the exact source host cache",
		);
		equal(item.candidates.length, 0, "the unarmed projection invents no certified host candidate");

		const held = holdClearHostLoad(item, "host-load:B:after-external", "certified target B");
		equal(
			item.host.data,
			"source A",
			"the certified clear=true load still holds its host cache behind source A",
		);
		const presented = item.guard?.presentHeldHostLoadLocally({
			candidate: held.candidate as Parameters<
				NonNullable<typeof item.guard>["presentHeldHostLoadLocally"]
			>[0]["candidate"],
			localPresentationId: "local:B:after-external",
		});
		equal(presented?.kind, "accepted", "the later certified clear=true target remains admissible");
		equal(item.view.state.doc.toString(), "certified target B", "the certified target reaches CodeMirror once");
		equal(item.host.data, "certified target B", "the certified target reaches the host cache once");
		const descriptorAfter = Object.getOwnPropertyDescriptor(item.host, "data");
		assert(
			descriptorBefore !== undefined
				&& descriptorAfter !== undefined
				&& descriptorAfter.configurable === descriptorBefore.configurable
				&& descriptorAfter.enumerable === descriptorBefore.enumerable
				&& descriptorAfter.writable === descriptorBefore.writable,
			"runtime data restoration preserves its original data descriptor",
		);
		destroy(item);
	}

	console.log("\n--- Contract Test 7: an unarmed setState projection restores the same source cache ---");
	{
		const item = fixture("source A");
		beginRejectBeforeTargetHandoff(item, "B.md");
		item.host.data = "external state B";
		item.view.setState(EditorState.create({
			doc: "external state B",
			extensions: item.extensions,
		}));
		equal(item.view.state.doc.toString(), "source A", "the unarmed setState stays outside CodeMirror");
		equal(item.host.data, "source A", "the unarmed setState restores the exact source host cache");
		equal(item.candidates.length, 0, "the unarmed setState invents no certified host candidate");
		destroy(item);
	}

	console.log("\n--- Contract Test 8: a failed runtime-data CAS never overwrites host bytes ---");
	{
		const item = fixture("source A");
		beginRejectBeforeTargetHandoff(item, "B.md");
		const incoming = "external B with failed CAS";
		const transaction = item.view.state.update({
			changes: { from: 0, to: item.view.state.doc.length, insert: incoming },
			filter: false,
		});
		item.host.data = incoming;
		const definePropertyDescriptor = Object.getOwnPropertyDescriptor(Object, "defineProperty");
		assert(definePropertyDescriptor !== undefined, "Object.defineProperty has a restorable descriptor");
		if (definePropertyDescriptor !== undefined) {
			const installedFailure = Reflect.defineProperty(Object, "defineProperty", {
				...definePropertyDescriptor,
				value(target: object, property: PropertyKey, attributes: PropertyDescriptor): object {
					if (target === item.host && property === "data") {
						throw new TypeError("synthetic runtime-data CAS failure");
					}
					return definePropertyDescriptor.value.call(Object, target, property, attributes) as object;
				},
			});
			assert(installedFailure, "the exact synthetic CAS failure is installed");
			try {
				item.view.dispatch(transaction);
			} finally {
				assert(
					Reflect.defineProperty(Object, "defineProperty", definePropertyDescriptor),
					"Object.defineProperty is restored after the exact CAS failure",
				);
			}
		}
		equal(item.view.state.doc.toString(), "source A", "CAS failure still rejects the target projection");
		equal(item.host.data, incoming, "CAS failure does not overwrite the expected incoming host bytes");
		assert(
			item.hostLoadCaptureRejections.includes("runtime-data-cas-failed"),
			"CAS failure is exposed through the existing capture rejection trace",
		);
		equal(item.candidates.length, 0, "CAS failure invents no certified host candidate");
		destroy(item);
	}

	console.log("\n--- Contract Test 9: stable same-path replacement remains untouched ---");
	{
		const item = fixture("source A");
		item.host.data = "stable same-path reload";
		item.view.dispatch(item.view.state.update({
			changes: {
				from: 0,
				to: item.view.state.doc.length,
				insert: "stable same-path reload",
			},
			filter: false,
		}));
		equal(item.view.state.doc.toString(), "stable same-path reload", "same-path replacement reaches CodeMirror");
		equal(item.host.data, "stable same-path reload", "same-path replacement keeps the host cache");
		equal(item.hostLoadCaptureRejections.length, 0, "same-path replacement emits no handoff rejection");
		destroy(item);
	}

const result = { passed, failed, failures };
window.__KAOS_TEST_RESULT__ = result;
return result;
}

window.__KAOS_TEST_DONE__ = runBrowserSuite().catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	failed += 1;
	failures.push(error instanceof Error ? error.message : String(error));
	const result = { passed, failed, failures };
	window.__KAOS_TEST_RESULT__ = result;
	return result;
});
