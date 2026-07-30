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
	captureGuardOwnedHandoffCompositionProof,
	handoffGateClosedFacet,
	handoffGateCompartment,
	handoffRecoveryGateActions,
	installCodeMirrorHandoffGuard,
	type CodeMirrorHandoffContext,
	type HandoffRecoveryGateAction,
	type HandoffRecoveryGateModel,
	type RoutedHandoffInputIntent,
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
	const samePathCompletions: unknown[] = [];
	const nativeHistoryAdvances: Array<Readonly<{
		cm: EditorView;
		startState: EditorState;
		finalState: EditorState;
		nativeHistoryEpochBefore: number;
		nativeHistoryEpochAfter: number;
	}>> = [];
	const intents: unknown[] = [];
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
	let intentDelivery: "acknowledge" | "reject" | "throw" = "acknowledge";
	let candidateDelivery: "acknowledge" | "reject" | "throw" = "acknowledge";
	let completionDelivery: "acknowledge" | "reject" | "throw" = "acknowledge";
	let candidateDeliveryHook: ((candidate: unknown, depth: number) => void) | null = null;
	let completionDeliveryHook: ((receipt: unknown, depth: number) => void) | null = null;
	let candidateCallbackDepth = 0;
	let completionCallbackDepth = 0;
	let candidateCallbackMaxDepth = 0;
	let completionCallbackMaxDepth = 0;
	let reservationOverride: Partial<FullInputStartReservation> | null | undefined;
	let recoveryGateModel: HandoffRecoveryGateModel | null = null;
	let exactHostStateReplacementDepth = 0;
	let exactHostPostDelegationDepth = 0;
	let bypassGuardUpdateBoundary = false;
	let rawUpdate: EditorView["update"] | null = null;
	const recoveryGateActions: HandoffRecoveryGateAction[] = [];
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
		onInputIntent(routed) {
			if (intentDelivery === "throw") throw new Error("intent-delivery-failed");
			if (intentDelivery === "reject") return false;
			intents.push(routed);
			return true;
		},
		onSamePathInputCompleted(completion) {
			samePathCompletions.push(completion);
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
		hashContent: (content) => `hash:${content}`,
		createId: (prefix) => `${prefix}-${nextId++}`,
		now: () => 1234,
		getHandoffRecoveryGateModel: () => recoveryGateModel,
		handoffRecoveryGateCallbacks: {
			onRetry: () => recoveryGateActions.push("retry"),
			onCopyAndContinue: () => recoveryGateActions.push("copy-and-continue"),
			onExportAndContinue: () => recoveryGateActions.push("export-and-continue"),
			onDiscardAndContinue: () => recoveryGateActions.push("discard-and-continue"),
			onContinueWithoutAutomaticApply: () => recoveryGateActions.push("continue-without-automatic-apply"),
			onRetrySettlement: () => recoveryGateActions.push("retry-settlement"),
		},
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
		samePathCompletions,
		nativeHistoryAdvances,
		intents,
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
		setIntentDelivery(value: "acknowledge" | "reject" | "throw"): void {
			intentDelivery = value;
		},
		setReservationOverride(value: Partial<FullInputStartReservation> | null): void {
			reservationOverride = value;
		},
		setRecoveryGateModel(value: HandoffRecoveryGateModel | null): void {
			recoveryGateModel = value;
		},
		recoveryGateActions,
		currentHandoff(): Extract<CodeMirrorHandoffContext, { kind: "handoff" }> {
			assert(context?.kind === "handoff", "fixture has a current handoff");
			return context;
		},
	};
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
console.log("\n--- Browser Test 1: replacement and unassociated views fail closed ---");
{
	const item = fixture("source A", false);
	const stale = item.view.state.update({
		changes: { from: 0, to: item.view.state.doc.length, insert: "stale replacement" },
		filter: false,
	});
	item.view.dispatch(stale);
	equal(item.view.state.doc.toString(), "source A", "unassociated replacement cannot change the document");
	equal(item.observedDocuments.length, 0, "sentinel never sees the unassociated bytes");
	destroy(item);
}

console.log("\n--- Browser Test 2: beforeinput and composition use reducer-owned order ---");
{
	const item = fixture();
	item.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		inputType: "insertText",
		data: "x",
	}));
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
	equal(item.reservations.length, 2, "each native sequence starts with one synchronous reducer reservation");
	equal(item.reservations[0]?.inputStartSeq, 1, "beforeinput receives the reducer's first sequence");
	equal(item.reservations[1]?.inputStartSeq, 2, "compositionstart receives the next reducer sequence");
	assert(item.guard?.snapshot().inputEpoch === 2, "input epoch follows sequence starts");
	assert(item.guard?.snapshot().compositionEpoch === 1, "composition epoch is local and monotonic");
	destroy(item);
}

console.log("\n--- Browser Test 2a: a closed handoff gate captures native DOM input without silencing it ---");
{
	const item = fixture("source A");
	item.view.dispatch({ selection: EditorSelection.cursor(item.view.state.doc.length) });
	item.view.focus();
	item.beginHandoff("B.md");
	equal(item.guard?.snapshot().gateClosed, true, "handoff keeps the logical input gate closed");
	equal(item.view.state.readOnly, false, "logical gate leaves CodeMirror writable so native input can become a transaction");
	item.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		cancelable: true,
		inputType: "insertText",
		data: "x",
	}));
	const line = item.view.contentDOM.querySelector<HTMLElement>(".cm-line");
	assert(line !== null, "native DOM input case has a mounted CodeMirror line");
	line.textContent = "source Ax";
	const textNode = line.firstChild;
	assert(textNode !== null, "native DOM input case has a rendered text node");
	const selection = document.getSelection();
	assert(selection !== null, "native DOM input case has a browser selection");
	const range = document.createRange();
	range.setStart(textNode, textNode.textContent?.length ?? 0);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
	await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	equal(item.intents.length, 1, "native DOM input becomes one reducer-owned handoff intent");
	const routed = item.intents[0] as RoutedHandoffInputIntent | undefined;
	equal(routed?.intent.afterContent, "source Ax", "captured intent retains the exact native successor bytes");
	equal(item.view.state.doc.toString(), "source A", "captured native input never mutates the source document");
	equal(item.view.contentDOM.textContent, "source A", "captured native input is removed from the rendered source editor");
	destroy(item);
}

console.log("\n--- Browser Test 3: spanning and missing-end composition are never replay eligible ---");
{
	const spanning = fixture();
	spanning.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
	spanning.beginHandoff();
	spanning.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true }));
	spanning.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
	equal(spanning.guard?.snapshot().lastComposition?.replayEligible, false, "switch-spanning composition is manual");
	destroy(spanning);

	const missingEnd = fixture();
	missingEnd.beginHandoff();
	missingEnd.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
	missingEnd.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true }));
	equal(missingEnd.guard?.snapshot().activeComposition?.replayEligible, false, "composition without end is not eligible");
	destroy(missingEnd);
}

console.log("\n--- Browser Test 3a: a closed gate keeps one native composition alive until its final successor ---");
{
	const item = fixture("source A");
	item.view.dispatch({ selection: EditorSelection.cursor(item.view.state.doc.length) });
	item.view.focus();
	item.beginHandoff("B.md");
	await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	const applyCompositionDom = async (text: string): Promise<void> => {
		const line = item.view.contentDOM.querySelector<HTMLElement>(".cm-line");
		assert(line !== null, "native composition has a mounted CodeMirror line");
		line.textContent = `source A${text}`;
		const textNode = line.firstChild;
		assert(textNode !== null, "native composition has a rendered text node");
		const selection = document.getSelection();
		assert(selection !== null, "native composition has a browser selection");
		const range = document.createRange();
		range.setStart(textNode, textNode.textContent?.length ?? 0);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
		item.view.contentDOM.dispatchEvent(new InputEvent("input", {
			bubbles: true,
			inputType: "insertCompositionText",
			data: text,
		}));
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	};
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "ㅎ" }));
	item.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		cancelable: true,
		inputType: "insertCompositionText",
		data: "ㅎ",
	}));
	await applyCompositionDom("ㅎ");
	equal(item.view.state.doc.toString(), "source A", "in-progress composition never mutates source authority");
	equal(item.view.contentDOM.textContent, "source Aㅎ", "first composing text remains visible without resetting Chromium IME");
	equal(item.intents.length, 0, "in-progress composition publishes no premature intent");
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
	item.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		cancelable: true,
		inputType: "insertCompositionText",
		data: "한",
	}));
	await applyCompositionDom("한");
	equal(item.view.contentDOM.textContent, "source A한", "second composing text stays in the same native composition");
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
	await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	equal(item.guard?.snapshot().compositionEpoch, 1, "one native composition retains one reducer epoch");
	equal(item.guard?.snapshot().activeComposition, null, "compositionend closes the exact active composition");
	equal(item.intents.length, 1, "compositionend publishes one exact final intent");
	equal((item.intents[0] as RoutedHandoffInputIntent | undefined)?.intent.afterContent, "source A한", "final IME intent retains the exact successor bytes");
	equal(item.view.state.doc.toString(), "source A", "completed IME never mutates source authority");
	equal(item.view.contentDOM.textContent, "source A", "completed IME restores the rendered source editor");
	destroy(item);
}

console.log("\n--- Browser Test 3aa: a preceding host input handler cannot force a composition state update ---");
{
	let hostInputHandlerCalls = 0;
	const hostInputHandler = Prec.highest(EditorView.inputHandler.of((target, _from, _to, _text, insert) => {
		hostInputHandlerCalls += 1;
		target.dispatch(insert());
		return true;
	}));
	const item = fixture("source A", true, true, [hostInputHandler]);
	item.view.dispatch({ selection: EditorSelection.cursor(item.view.state.doc.length) });
	item.view.focus();
	item.beginHandoff("B.md");
	await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	const observedBeforeNative = item.observedTransactions.length;
	const applyCompositionDom = async (text: string): Promise<void> => {
		const line = item.view.contentDOM.querySelector<HTMLElement>(".cm-line");
		assert(line !== null, "preceding host handler case has a mounted CodeMirror line");
		line.textContent = `source A${text}`;
		const textNode = line.firstChild;
		assert(textNode !== null, "preceding host handler case has a rendered text node");
		const selection = document.getSelection();
		assert(selection !== null, "preceding host handler case has a browser selection");
		const range = document.createRange();
		range.setStart(textNode, textNode.textContent?.length ?? 0);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
		item.view.contentDOM.dispatchEvent(new InputEvent("input", {
			bubbles: true,
			inputType: "insertCompositionText",
			data: text,
		}));
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	};
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "ㅎ" }));
	item.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		cancelable: true,
		inputType: "insertCompositionText",
		data: "ㅎ",
	}));
	await applyCompositionDom("ㅎ");
	equal(hostInputHandlerCalls, 1, "the preceding host handler owns the native insertion callback");
	equal(item.observedTransactions.length, observedBeforeNative, "capturing its composition transaction applies no CodeMirror state update");
	equal(item.view.state.doc.toString(), "source A", "preceding host handler cannot mutate source authority");
	equal(item.view.contentDOM.textContent, "source Aㅎ", "captured composing DOM stays mounted for Chromium IME");
	equal(item.guard?.snapshot().compositionEpoch, 1, "host-routed update remains in the original composition epoch");
	equal(item.intents.length, 0, "host-routed intermediate composition publishes no intent");
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
	item.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		cancelable: true,
		inputType: "insertCompositionText",
		data: "한",
	}));
	await applyCompositionDom("한");
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
	await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	equal(hostInputHandlerCalls, 2, "the same host handler observes both native composition updates");
	equal(item.guard?.snapshot().compositionEpoch, 1, "two host-routed updates retain one composition epoch");
	equal(item.guard?.snapshot().activeComposition, null, "compositionend closes the host-routed composition");
	equal(item.intents.length, 1, "host-routed composition emits one final intent");
	equal((item.intents[0] as RoutedHandoffInputIntent | undefined)?.intent.afterContent, "source A한", "host-routed final intent retains exact successor bytes");
	equal(item.view.state.doc.toString(), "source A", "host-routed completion leaves source authority unchanged");
	destroy(item);
}

console.log("\n--- Browser Test 3b: a non-composing native commit closes an IME when compositionend is omitted ---");
{
	const item = fixture("source A");
	item.view.dispatch({ selection: EditorSelection.cursor(item.view.state.doc.length) });
	item.view.focus();
	item.beginHandoff("B.md");
	await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
	item.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
	item.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		cancelable: true,
		inputType: "insertCompositionText",
		data: "한",
	}));
	const writeDom = (inputType: "insertCompositionText" | "insertText"): void => {
		const line = item.view.contentDOM.querySelector<HTMLElement>(".cm-line");
		assert(line !== null, "implicit IME commit has a mounted CodeMirror line");
		line.textContent = "source A한";
		const textNode = line.firstChild;
		assert(textNode !== null, "implicit IME commit has a rendered text node");
		const selection = document.getSelection();
		assert(selection !== null, "implicit IME commit has a browser selection");
		const range = document.createRange();
		range.setStart(textNode, textNode.textContent?.length ?? 0);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
		item.view.contentDOM.dispatchEvent(new InputEvent("input", {
			bubbles: true,
			inputType,
			data: "한",
		}));
	};
	writeDom("insertCompositionText");
	await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	item.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		cancelable: true,
		inputType: "insertText",
		data: "한",
	}));
	writeDom("insertText");
	await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	equal(item.guard?.snapshot().activeComposition, null, "non-composing native commit closes the exact active composition");
	equal(item.intents.length, 1, "implicit composition completion publishes one exact final intent");
	equal((item.intents[0] as RoutedHandoffInputIntent | undefined)?.intent.afterContent, "source A한", "implicit completion retains the exact successor bytes");
	equal(item.view.state.doc.toString(), "source A", "implicit completion leaves source authority unchanged");
	equal(item.view.contentDOM.textContent, "source A", "implicit completion restores the rendered source editor");
	destroy(item);
}

console.log("\n--- Browser Test 3c: Korean IME intent waits for the exact compositionend successor ---");
{
	const korean = fixture("source A");
	korean.beginHandoff("B.md");
	korean.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	korean.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
	const finalKorean = korean.view.state.update({
		changes: { from: korean.view.state.doc.length, insert: "한" },
		selection: EditorSelection.cursor(korean.view.state.doc.length + 1),
		userEvent: "input.type.compose",
		filter: false,
	});
	korean.view.dispatch(finalKorean);
	equal(korean.intents.length, 0, "IME transaction is retained but not delivered before compositionend");
	korean.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
	equal(korean.intents.length, 1, "compositionend delivers the final Korean successor once");
	const koreanRoute = korean.intents[0] as RoutedHandoffInputIntent;
	equal(koreanRoute.disposition, "replay-candidate", "fully proven current Korean IME is explicitly replay-candidate");
	equal(koreanRoute.reason, null, "replay-candidate carries no manual reason");
	const koreanIntent = koreanRoute.intent;
	equal(koreanIntent?.changes, finalKorean.changes, "IME intent retains the exact native ChangeSet");
	equal(koreanIntent?.selectionAfter, finalKorean.newSelection, "IME intent retains the exact final selection");
	equal(koreanIntent?.afterContent, "source A한", "IME intent retains the exact final successor document");
	const koreanProof = captureGuardOwnedHandoffCompositionProof(koreanIntent);
	equal(koreanProof.kind, "ready", "exact emitted IME intent owns one live composition proof");
	if (koreanProof.kind === "ready") {
		equal(koreanProof.proof.firstInputSeq, koreanIntent.inputStartSeq, "proof cursor starts at the reducer-reserved input sequence");
		equal(koreanProof.proof.lastInputSeq, koreanIntent.inputStartSeq, "one captured native transaction advances one input sequence");
		equal(koreanProof.proof.endSeq, koreanIntent.inputStartSeq + 1, "exact compositionend advances the next proof sequence");
	}
	equal(
		captureGuardOwnedHandoffCompositionProof({ ...koreanIntent }).kind,
		"unavailable",
		"equal-fields foreign intent cannot read the exact-object proof",
	);
	equal(korean.guard?.snapshot().lastComposition?.replayEligible, true, "completed same-generation Korean composition is replay eligible");
	destroy(korean);
	equal(
		captureGuardOwnedHandoffCompositionProof(koreanIntent).kind,
		"unavailable",
		"guard teardown revokes its previously emitted proof",
	);

	const multiple = fixture("source A");
	multiple.beginHandoff("B.md");
	multiple.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	multiple.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
	multiple.view.dispatch(multiple.view.state.update({
		changes: { from: multiple.view.state.doc.length, insert: "한" },
		userEvent: "input.type.compose",
		filter: false,
	}));
	multiple.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한국" }));
	multiple.view.dispatch(multiple.view.state.update({
		changes: { from: multiple.view.state.doc.length, insert: "한국" },
		userEvent: "input.type.compose",
		filter: false,
	}));
	multiple.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한국" }));
	const multipleIntent = (multiple.intents[0] as RoutedHandoffInputIntent | undefined)?.intent;
	assert(multipleIntent !== undefined, "multiple native composition transactions emit one exact final intent");
	const multipleProof = captureGuardOwnedHandoffCompositionProof(multipleIntent);
	assert(multipleProof.kind === "ready", "multiple captured native transactions retain a live proof");
	equal(multipleProof.proof.lastInputSeq, multipleProof.proof.firstInputSeq + 1, "each associated native transaction advances the proof cursor once");
	equal(multipleProof.proof.endSeq, multipleProof.proof.lastInputSeq + 1, "compositionend advances the cursor after all native transactions");
	equal(multiple.guard?.markInert(), true, "completed composition guard can become inert");
	equal(
		captureGuardOwnedHandoffCompositionProof(multipleIntent).kind,
		"unavailable",
		"inert guard revokes its previously emitted proof",
	);
	destroy(multiple);

	const missingEnd = fixture("source A");
	missingEnd.beginHandoff("B.md");
	const missingContext = missingEnd.currentHandoff();
	missingEnd.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	missingEnd.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
	const missingTransaction = missingEnd.view.state.update({
		changes: { from: missingEnd.view.state.doc.length, insert: "한" },
		selection: EditorSelection.cursor(missingEnd.view.state.doc.length + 1),
		userEvent: "input.type.compose",
		filter: false,
	});
	missingEnd.view.dispatch(missingTransaction);
	equal(missingEnd.intents.length, 0, "missing compositionend never delivers a replay-eligible intent");
	missingEnd.setIntentDelivery("throw");
	equal(missingEnd.guard?.markInert(), false, "callback throw cannot erase an unfinished Korean IME item");
	equal(missingEnd.guard?.snapshot().inert, false, "failed missing-end delivery keeps teardown live and retryable");
	equal(missingEnd.intents.length, 0, "throwing callback acknowledges no manual item");
	missingEnd.setIntentDelivery("acknowledge");
	equal(missingEnd.guard?.markInert(), true, "teardown retries after manual recovery acknowledges the missing-end item");
	equal(missingEnd.intents.length, 1, "missing-end successor is emitted exactly once before teardown");
	const missingRoute = missingEnd.intents[0] as RoutedHandoffInputIntent | undefined;
	equal(missingRoute?.disposition, "manual-recovery", "missing-end Korean IME is explicitly manual recovery");
	equal(missingRoute?.reason, "missing-composition-end", "missing-end route carries its closed reason");
	equal(missingRoute?.intent.changes, missingTransaction.changes, "missing-end route preserves the exact native ChangeSet");
	equal(missingRoute?.intent.selectionAfter, missingTransaction.newSelection, "missing-end route preserves exact selection");
	equal(missingRoute?.intent.afterContent, "source A한", "missing-end route preserves the exact successor");
	equal(missingRoute?.intent.sessionId, missingContext.sessionId, "missing-end route preserves the original session");
	equal(missingRoute?.intent.handoffGeneration, missingContext.handoffGeneration, "missing-end route preserves original generation");
	equal(missingRoute?.intent.targetFile, missingContext.targetFile, "missing-end route preserves original target identity");
	if (missingRoute) {
		equal(
			captureGuardOwnedHandoffCompositionProof(missingRoute.intent).kind,
			"unavailable",
			"missing compositionend manual intent never receives a proof",
		);
	}
	equal(missingEnd.guard?.markInert(), true, "repeated teardown is idempotent after acknowledgement");
	equal(missingEnd.intents.length, 1, "repeated teardown cannot duplicate the manual item");
	destroy(missingEnd);

	const replacedComposition = fixture("source A");
	replacedComposition.beginHandoff("B.md");
	replacedComposition.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	replacedComposition.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
	const replacedTransaction = replacedComposition.view.state.update({
		changes: { from: replacedComposition.view.state.doc.length, insert: "한" },
		userEvent: "input.type.compose",
		filter: false,
	});
	replacedComposition.view.dispatch(replacedTransaction);
	replacedComposition.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㄱ" }));
	equal(replacedComposition.intents.length, 1, "a new composition first routes the prior exact missing-end successor");
	equal((replacedComposition.intents[0] as RoutedHandoffInputIntent | undefined)?.reason, "missing-composition-end", "replacement composition uses the missing-end reason");
	equal((replacedComposition.intents[0] as RoutedHandoffInputIntent | undefined)?.intent?.changes, replacedTransaction.changes, "replacement preserves the prior exact ChangeSet");
	equal(replacedComposition.guard?.snapshot().activeComposition?.compositionEpoch, 2, "new composition starts only after prior manual acknowledgement");
	destroy(replacedComposition);

	const noSuccessor = fixture("source A");
	noSuccessor.beginHandoff("B.md");
	noSuccessor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	noSuccessor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
	equal(noSuccessor.guard?.markInert(), false, "missing-end teardown without an exact successor fails closed");
	equal(noSuccessor.guard?.snapshot().inert, false, "unproven missing-end teardown retains the live guard");
	equal(noSuccessor.intents.length, 0, "unproven missing-end teardown synthesizes no recovery bytes");
	destroy(noSuccessor);

	const updateGap = fixture("source A");
	updateGap.beginHandoff("B.md");
	const updateGapContext = updateGap.currentHandoff();
	updateGap.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	updateGap.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
	const updateGapTransaction = updateGap.view.state.update({
		changes: { from: updateGap.view.state.doc.length, insert: "한" },
		selection: EditorSelection.cursor(updateGap.view.state.doc.length + 1),
		userEvent: "input.type.compose",
		filter: false,
	});
	updateGap.view.dispatch(updateGapTransaction);
	updateGap.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한국" }));
	updateGap.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한국" }));
	equal(updateGap.intents.length, 1, "an exact successor with an update gap is retained once for manual recovery");
	const gapRoute = updateGap.intents[0] as RoutedHandoffInputIntent | undefined;
	equal(gapRoute?.disposition, "manual-recovery", "update-gap Korean IME cannot become a replay candidate");
	equal(gapRoute?.reason, "composition-update-gap", "update-gap route carries its closed reason");
	equal(gapRoute?.intent.changes, updateGapTransaction.changes, "update-gap route preserves exact ChangeSet identity");
	equal(gapRoute?.intent.selectionAfter, updateGapTransaction.newSelection, "update-gap route preserves exact selection");
	equal(gapRoute?.intent.afterContent, "source A한", "update-gap route preserves the last exact successor");
	equal(gapRoute?.intent.sessionId, updateGapContext.sessionId, "update-gap route preserves original session");
	equal(gapRoute?.intent.handoffGeneration, updateGapContext.handoffGeneration, "update-gap route preserves original generation");
	equal(gapRoute?.intent.targetFile, updateGapContext.targetFile, "update-gap route preserves original target identity");
	equal(
		updateGap.intents.filter((item) => (item as RoutedHandoffInputIntent).disposition === "replay-candidate").length,
		0,
		"update-gap route produces zero replay candidates",
	);
	equal(updateGap.guard?.snapshot().lastComposition?.replayEligible, false, "update-gap composition is never replay eligible");
	if (gapRoute) {
		equal(
			captureGuardOwnedHandoffCompositionProof(gapRoute.intent).kind,
			"unavailable",
			"gapped composition cannot own a proof",
		);
	}
	updateGap.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	updateGap.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
	const laterClean = updateGap.view.state.update({
		changes: { from: updateGap.view.state.doc.length, insert: "한" },
		selection: EditorSelection.cursor(updateGap.view.state.doc.length + 1),
		userEvent: "input.type.compose",
		filter: false,
	});
	updateGap.view.dispatch(laterClean);
	updateGap.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
	equal(updateGap.intents.length, 2, "later clean Korean IME routes independently after a manual item");
	equal((updateGap.intents[1] as RoutedHandoffInputIntent | undefined)?.disposition, "replay-candidate", "later clean IME remains replay-candidate");
	destroy(updateGap);

	const spanning = fixture("source A");
	spanning.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	spanning.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
	const spanningReservation = spanning.reservations[0];
	spanning.beginHandoff("B.md");
	const spanningB = spanning.currentHandoff();
	const spanningTransaction = spanning.view.state.update({
		changes: { from: spanning.view.state.doc.length, insert: "한" },
		selection: EditorSelection.cursor(spanning.view.state.doc.length + 1),
		userEvent: "input.type.compose",
		filter: false,
	});
	spanning.view.dispatch(spanningTransaction);
	equal(spanning.intents.length, 0, "switch-spanning IME is not delivered before compositionend");
	spanning.beginHandoff("C.md");
	const spanningC = spanning.currentHandoff();
	const spanningLatestTransaction = spanning.view.state.update({
		changes: { from: spanning.view.state.doc.length, insert: "한국" },
		selection: EditorSelection.cursor(spanning.view.state.doc.length + 2),
		userEvent: "input.type.compose",
		filter: false,
	});
	spanning.view.dispatch(spanningLatestTransaction);
	spanning.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한국" }));
	equal(spanning.intents.length, 1, "B-to-C spanning exact successor is emitted once for manual recovery");
	const spanningRoute = spanning.intents[0] as RoutedHandoffInputIntent | undefined;
	equal(spanningRoute?.disposition, "manual-recovery", "B-to-C spanning IME cannot become a replay candidate");
	equal(spanningRoute?.reason, "switch-spanning", "B-to-C route carries its closed reason");
	equal(spanningRoute?.intent.changes, spanningLatestTransaction.changes, "B-to-C route preserves the latest exact ChangeSet identity");
	equal(spanningRoute?.intent.selectionAfter, spanningLatestTransaction.newSelection, "B-to-C route preserves the latest exact selection");
	equal(spanningRoute?.intent.afterContent, "source A한국", "B-to-C route preserves the latest exact successor bytes");
	equal(spanningRoute?.intent.sessionId, spanningB.sessionId, "B-to-C route preserves original session");
	equal(spanningRoute?.intent.leafId, spanningB.leafId, "B-to-C route preserves original leaf");
	equal(spanningRoute?.intent.handoffGeneration, spanningB.handoffGeneration, "B-to-C route preserves B generation");
	equal(spanningRoute?.intent.switchIntentSeq, spanningB.switchIntentSeq, "B-to-C route preserves B switch lineage");
	equal(spanningRoute?.intent.fromPath, spanningB.fromPath, "B-to-C route preserves B source path");
	equal(spanningRoute?.intent.fromFileId, spanningB.fromFileId, "B-to-C route preserves B source identity");
	equal(spanningRoute?.intent.targetPath, spanningB.targetPath, "B-to-C route preserves B target path");
	equal(spanningRoute?.intent.targetFile, spanningB.targetFile, "B-to-C route preserves exact B TFile");
	equal(spanningRoute?.intent.bindingEpoch, spanningB.bindingEpoch, "B-to-C route preserves B binding epoch");
	equal(spanningRoute?.intent.sequenceBegan, "before-handoff", "A-to-B association remains explicitly before-handoff after C");
	equal(spanningRoute?.intent.startDocument, spanningReservation?.sourceDocumentAtStart, "B-to-C route retains the exact reserved A document");
	equal(spanningRoute?.intent.handoffGeneration === spanningC.handoffGeneration, false, "B-to-C route never inherits C generation");
	equal(spanningRoute?.intent.switchIntentSeq === spanningC.switchIntentSeq, false, "B-to-C route never inherits C switch lineage");
	equal(spanningRoute?.intent.targetPath === spanningC.targetPath, false, "B-to-C route never inherits C target path");
	equal(spanningRoute?.intent.targetFile === spanningC.targetFile, false, "B-to-C route never inherits C TFile identity");
	equal(
		spanning.intents.filter((item) => (item as RoutedHandoffInputIntent).disposition === "replay-candidate").length,
		0,
		"B-to-C spanning route produces zero replay candidates",
	);
	equal(spanning.guard?.snapshot().lastComposition?.replayEligible, false, "switch-spanning final successor remains manual-only");
	if (spanningRoute) {
		equal(
			captureGuardOwnedHandoffCompositionProof(spanningRoute.intent).kind,
			"unavailable",
			"context-drifted composition cannot own a proof",
		);
	}
	destroy(spanning);

	const samePathCompletion = fixture("source A");
	samePathCompletion.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	samePathCompletion.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
	const samePathStartDocument = samePathCompletion.view.state.doc;
	const samePathTransaction = samePathCompletion.view.state.update({
		changes: { from: samePathCompletion.view.state.doc.length, insert: "한" },
		selection: EditorSelection.cursor(samePathCompletion.view.state.doc.length + 1),
		userEvent: "input.type.compose",
		filter: false,
	});
	samePathCompletion.view.dispatch(samePathTransaction);
	equal(samePathCompletion.view.state.doc.toString(), "source A한", "ordinary same-path IME remains a forwarded local edit");
	samePathCompletion.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
	equal(samePathCompletion.guard?.snapshot().activeComposition, null, "completed same-path IME clears active composition bookkeeping");
	equal(samePathCompletion.guard?.snapshot().gateFailureReason, null, "completed same-path IME leaves no recovery failure");
	equal(samePathCompletion.samePathCompletions.length, 1, "completed same-path IME publishes one completion receipt request");
	const firstSamePathCompletion = samePathCompletion.samePathCompletions[0] as Readonly<{
		reservation: unknown;
		cm: EditorView;
		startDocument: unknown;
		finalDocument: unknown;
	}>;
	equal(firstSamePathCompletion.reservation, samePathCompletion.reservations[0], "same-path completion preserves the exact input reservation");
	equal(firstSamePathCompletion.cm, samePathCompletion.view, "same-path completion preserves the exact CodeMirror");
	equal(firstSamePathCompletion.startDocument, samePathStartDocument, "same-path completion preserves the exact pre-IME document");
	equal(firstSamePathCompletion.finalDocument, samePathCompletion.view.state.doc, "same-path completion preserves the exact final document");
	samePathCompletion.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㄱ" }));
	equal(samePathCompletion.guard?.snapshot().activeComposition?.compositionEpoch, 2, "a second same-path composition can start after normal completion");
	samePathCompletion.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "가" }));
	const secondSamePathTransaction = samePathCompletion.view.state.update({
		changes: { from: samePathCompletion.view.state.doc.length, insert: "가" },
		selection: EditorSelection.cursor(samePathCompletion.view.state.doc.length + 1),
		userEvent: "input.type.compose",
		filter: false,
	});
	samePathCompletion.view.dispatch(secondSamePathTransaction);
	samePathCompletion.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "가" }));
	equal(samePathCompletion.guard?.snapshot().activeComposition, null, "repeated same-path completion also clears bookkeeping");
	equal(samePathCompletion.samePathCompletions.length, 2, "repeated same-path IME publishes exactly one new completion request");
	equal(samePathCompletion.guard?.markInert(), true, "normal same-path IME completion never wedges teardown");
	destroy(samePathCompletion);

	const sourceSettledBeforeSelectionEnd = fixture("source A");
	sourceSettledBeforeSelectionEnd.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", {
		bubbles: true,
		data: "ㅎ",
	}));
	sourceSettledBeforeSelectionEnd.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", {
		bubbles: true,
		data: "하",
	}));
	const sourceSettledStartDocument = sourceSettledBeforeSelectionEnd.view.state.doc;
	const sourceSettledTransaction = sourceSettledBeforeSelectionEnd.view.state.update({
		changes: {
			from: sourceSettledBeforeSelectionEnd.view.state.doc.length,
			insert: "한",
		},
		selection: EditorSelection.cursor(
			sourceSettledBeforeSelectionEnd.view.state.doc.length + 1,
		),
		userEvent: "input.type.compose",
		filter: false,
	});
	sourceSettledBeforeSelectionEnd.view.dispatch(sourceSettledTransaction);
	equal(
		sourceSettledBeforeSelectionEnd.view.state.doc.toString(),
		"source A한",
		"pre-selection final IME successor lands on the proven source",
	);
	const sourceSettledReservation = sourceSettledBeforeSelectionEnd.reservations[0];
	sourceSettledBeforeSelectionEnd.beginHandoff("B.md");
	const sourceSettledHandoff = sourceSettledBeforeSelectionEnd.currentHandoff();
	equal(
		sourceSettledHandoff.switchIntentSeq,
		(sourceSettledReservation?.inputStartSeq ?? -1) + 1,
		"target selection immediately follows the source IME reservation",
	);
	sourceSettledBeforeSelectionEnd.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", {
		bubbles: true,
		data: "한",
	}));
	equal(
		sourceSettledBeforeSelectionEnd.samePathCompletions.length,
		1,
		"compositionend after target selection still certifies the already-settled source input",
	);
	const selectedSourceCompletion = sourceSettledBeforeSelectionEnd.samePathCompletions[0] as Readonly<{
		reservation: unknown;
		cm: EditorView;
		startDocument: unknown;
		finalDocument: unknown;
	}> | undefined;
	equal(
		selectedSourceCompletion?.reservation,
		sourceSettledReservation,
		"post-selection source completion retains the exact pre-selection reservation",
	);
	equal(
		selectedSourceCompletion?.startDocument,
		sourceSettledStartDocument,
		"post-selection source completion retains the exact source start document",
	);
	equal(
		selectedSourceCompletion?.finalDocument,
		sourceSettledBeforeSelectionEnd.view.state.doc,
		"post-selection source completion retains the exact current source document",
	);
	equal(
		sourceSettledBeforeSelectionEnd.intents.length,
		0,
		"already-settled source input is not duplicated as a handoff replay intent",
	);
	equal(
		sourceSettledBeforeSelectionEnd.guard?.snapshot().gateFailureReason,
		null,
		"exact source-held completion leaves no recovery failure",
	);
	destroy(sourceSettledBeforeSelectionEnd);

	const missingSamePathEnd = fixture("source A");
	missingSamePathEnd.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	missingSamePathEnd.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
	const missingSamePathTransaction = missingSamePathEnd.view.state.update({
		changes: { from: missingSamePathEnd.view.state.doc.length, insert: "한" },
		selection: EditorSelection.cursor(missingSamePathEnd.view.state.doc.length + 1),
		userEvent: "input.type.compose",
		filter: false,
	});
	missingSamePathEnd.view.dispatch(missingSamePathTransaction);
	assert(missingSamePathEnd.guard?.snapshot().activeComposition !== null, "same-path IME remains active when compositionend is absent");
	equal(missingSamePathEnd.guard?.markInert(), true, "missing compositionend settles a clean exact same-path composition during inert teardown");
	equal(missingSamePathEnd.view.state.doc.toString(), "source A한", "same-path missing-end settlement retains already-forwarded native bytes");
	equal(missingSamePathEnd.intents.length, 0, "same-path missing-end settlement synthesizes no recovery bytes");
	equal(missingSamePathEnd.samePathCompletions.length, 0, "teardown settlement never certifies a native same-path completion");
	destroy(missingSamePathEnd);

	const missingSamePathRestore = fixture("source A");
	missingSamePathRestore.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	missingSamePathRestore.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
	const missingRestoreTransaction = missingSamePathRestore.view.state.update({
		changes: { from: missingSamePathRestore.view.state.doc.length, insert: "한" },
		selection: EditorSelection.cursor(missingSamePathRestore.view.state.doc.length + 1),
		userEvent: "input.type.compose",
		filter: false,
	});
	missingSamePathRestore.view.dispatch(missingRestoreTransaction);
	equal(missingSamePathRestore.guard?.restoreIfCurrent(), true, "missing compositionend settles the same clean exact same-path composition during wrapper restore");
	equal(missingSamePathRestore.view.state.doc.toString(), "source A한", "restore after missing compositionend retains forwarded same-path bytes");
	equal(missingSamePathRestore.intents.length, 0, "restore after same-path missing-end produces no recovery intent");
	missingSamePathRestore.view.destroy();
	missingSamePathRestore.parent.remove();

	const missingSamePathDrift = fixture("source A");
	missingSamePathDrift.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	missingSamePathDrift.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
	const driftedSamePathTransaction = missingSamePathDrift.view.state.update({
		changes: { from: missingSamePathDrift.view.state.doc.length, insert: "한" },
		selection: EditorSelection.cursor(missingSamePathDrift.view.state.doc.length + 1),
		userEvent: "input.type.compose",
		filter: false,
	});
	missingSamePathDrift.view.dispatch(driftedSamePathTransaction);
	missingSamePathDrift.setContext({
		kind: "same-path",
		sessionId: "session-1",
		leafId: "leaf-1",
		handoffGeneration: 2,
		path: "A.md",
	});
	equal(missingSamePathDrift.guard?.markInert(), false, "missing-end same-path settlement fails closed after generation drift");
	assert(missingSamePathDrift.guard?.snapshot().activeComposition !== null, "generation drift retains active IME authority for recovery");
	equal(missingSamePathDrift.intents.length, 0, "generation drift never invents same-path recovery bytes");
	missingSamePathDrift.setContext({
		kind: "same-path",
		sessionId: "session-1",
		leafId: "leaf-1",
		handoffGeneration: 1,
		path: "A.md",
	});
	destroy(missingSamePathDrift);

	const nullOrigin = fixture("source A");
	nullOrigin.beginHandoff("B.md");
	const abandonedB = nullOrigin.currentHandoff();
	nullOrigin.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		inputType: "insertText",
		data: "b",
	}));
	nullOrigin.setContext(null);
	nullOrigin.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		inputType: "insertText",
		data: "x",
	}));
	nullOrigin.beginHandoff("C.md");
	const postNullTransaction = nullOrigin.view.state.update({
		changes: { from: nullOrigin.view.state.doc.length, insert: "x" },
		selection: EditorSelection.cursor(nullOrigin.view.state.doc.length + 1),
		userEvent: "input.type",
		filter: false,
	});
	nullOrigin.view.dispatch(postNullTransaction);
	equal(nullOrigin.intents.length, 0, "null-context input start invalidates an abandoned handoff reservation");
	equal(nullOrigin.view.state.doc.toString(), "source A", "post-null input fails closed instead of applying bytes");
	equal(nullOrigin.intents.some((item) => (item as RoutedHandoffInputIntent).intent.targetFile === abandonedB.targetFile), false, "post-null input cannot inherit the abandoned B TFile");
	destroy(nullOrigin);

	const beforeHandoff = fixture("source A");
	beforeHandoff.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
	beforeHandoff.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
	const beforeReservation = beforeHandoff.reservations[0];
	equal(beforeReservation?.sourceFileAtStart, beforeHandoff.sourceFile, "same-path reservation retains the exact A TFile");
	equal(beforeReservation?.sourceFileIdAtStart, beforeHandoff.sourceFileId, "same-path reservation retains the A file identity");
	equal(beforeReservation?.sourceDocumentAtStart, beforeHandoff.view.state.doc, "same-path reservation retains the exact A document");
	equal(beforeReservation?.targetPathAtStart, null, "same-path reservation proves no target path existed at input start");
	equal(beforeReservation?.targetFileAtStart, null, "same-path reservation proves no target TFile existed at input start");
	beforeHandoff.beginHandoff("B.md");
	const associatedB = beforeHandoff.currentHandoff();
	equal(associatedB.switchIntentSeq, (beforeReservation?.inputStartSeq ?? -1) + 1, "B switch is the immediate reducer successor to A input start");
	const beforeHandoffTransaction = beforeHandoff.view.state.update({
		changes: { from: beforeHandoff.view.state.doc.length, insert: "한" },
		selection: EditorSelection.cursor(beforeHandoff.view.state.doc.length + 1),
		userEvent: "input.type.compose",
		filter: false,
	});
	beforeHandoff.view.dispatch(beforeHandoffTransaction);
	beforeHandoff.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
	equal(beforeHandoff.intents.length, 1, "proven A-to-B composition is retained once for manual recovery");
	const beforeRoute = beforeHandoff.intents[0] as RoutedHandoffInputIntent | undefined;
	equal(beforeRoute?.disposition, "manual-recovery", "proven A-to-B composition is manual-only");
	equal(beforeRoute?.reason, "switch-spanning", "proven A-to-B composition carries the switch-spanning reason");
	equal(beforeRoute?.intent.sequenceBegan, "before-handoff", "proven A-to-B sequence is explicitly before-handoff");
	equal(beforeRoute?.intent.handoffGeneration, associatedB.handoffGeneration, "proven A-to-B intent uses B generation");
	equal(beforeRoute?.intent.switchIntentSeq, associatedB.switchIntentSeq, "proven A-to-B intent uses B switch lineage");
	equal(beforeRoute?.intent.fromPath, beforeReservation?.sourceAuthorityPathAtStart, "proven A-to-B intent uses reserved A source path");
	equal(beforeRoute?.intent.fromFileId, beforeReservation?.sourceFileIdAtStart, "proven A-to-B intent uses reserved A file identity");
	equal(beforeRoute?.intent.startDocument, beforeReservation?.sourceDocumentAtStart, "proven A-to-B intent uses the exact reserved A document");
	equal(beforeRoute?.intent.targetPath, associatedB.targetPath, "proven A-to-B intent targets B path");
	equal(beforeRoute?.intent.targetFile, associatedB.targetFile, "proven A-to-B intent targets exact B TFile");
	equal(beforeRoute?.intent.changes, beforeHandoffTransaction.changes, "proven A-to-B intent retains the exact native ChangeSet");
	equal(beforeRoute?.intent.selectionAfter, beforeHandoffTransaction.newSelection, "proven A-to-B intent retains exact selection");
	equal(beforeRoute?.intent.afterContent, "source A한", "proven A-to-B intent retains exact successor bytes");
	equal(beforeHandoff.intents.filter((item) => (item as RoutedHandoffInputIntent).disposition === "replay-candidate").length, 0, "proven A-to-B composition emits zero replay candidates");
	equal(beforeHandoff.guard?.markInert(), true, "acknowledged A-to-B manual recovery allows teardown");
	destroy(beforeHandoff);

	type HandoffContext = Extract<CodeMirrorHandoffContext, { kind: "handoff" }>;
	const invalidBeforeHandoffProofs: readonly Readonly<{
		label: string;
		reservation: Partial<FullInputStartReservation> | null;
		mutateHandoff?: (handoff: HandoffContext) => HandoffContext;
	}>[] = [
		{ label: "missing source TFile", reservation: { sourceFileAtStart: null } },
		{ label: "missing source file id", reservation: { sourceFileIdAtStart: null } },
		{ label: "missing source document", reservation: { sourceDocumentAtStart: null } },
		{ label: "mismatched source TFile", reservation: { sourceFileAtStart: file("Other.md") } },
		{ label: "mismatched source path", reservation: { sourceAuthorityPathAtStart: "Other.md" } },
		{ label: "target already existed at start", reservation: { targetPathAtStart: "B.md", targetFileAtStart: file("B.md") } },
		{
			label: "generation skipped",
			reservation: {},
			mutateHandoff: (handoff) => ({ ...handoff, handoffGeneration: handoff.handoffGeneration + 1 }),
		},
		{
			label: "switch successor skipped",
			reservation: {},
			mutateHandoff: (handoff) => ({ ...handoff, switchIntentSeq: handoff.switchIntentSeq + 1 }),
		},
		{
			label: "current source mismatch",
			reservation: {},
			mutateHandoff: (handoff) => ({ ...handoff, fromPath: "Other.md" }),
		},
		{ label: "null reservation", reservation: null },
	];
	for (const invalidProof of invalidBeforeHandoffProofs) {
		const invalid = fixture("source A");
		invalid.setReservationOverride(invalidProof.reservation);
		invalid.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
		invalid.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "하" }));
		const selectedB = invalid.selectHandoff("B.md");
		invalid.setContext(invalidProof.mutateHandoff?.(selectedB) ?? selectedB);
		equal(invalid.guard?.refreshGate(), true, `${invalidProof.label}: handoff gate still reconfigures`);
		const invalidTransaction = invalid.view.state.update({
			changes: { from: invalid.view.state.doc.length, insert: "한" },
			selection: EditorSelection.cursor(invalid.view.state.doc.length + 1),
			userEvent: "input.type.compose",
			filter: false,
		});
		invalid.view.dispatch(invalidTransaction);
		invalid.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
		equal(invalid.intents.length, 0, `${invalidProof.label}: unproven A-to-B authority emits no intent`);
		equal(invalid.view.state.doc.toString(), "source A", `${invalidProof.label}: unproven bytes fail closed`);
		equal(invalid.intents.filter((item) => (item as RoutedHandoffInputIntent).disposition === "replay-candidate").length, 0, `${invalidProof.label}: unproven authority emits no replay candidate`);
		destroy(invalid);
	}
}

console.log("\n--- Browser Test 4: a pending DOM mutation flushes before reconfiguration ---");
{
	const item = fixture("source A");
	item.view.focus();
	item.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		inputType: "insertText",
		data: "!",
	}));
	const observer = (item.view as unknown as { observer: { forceFlush: () => unknown } }).observer;
	observer.forceFlush = () => undefined;
	const line = item.view.contentDOM.querySelector(".cm-line");
	assert(line !== null, "real CodeMirror line is mounted");
	const textNode = line.firstChild;
	assert(textNode !== null && textNode.nodeType === Node.TEXT_NODE, "real CodeMirror text node is mounted");
	const selection = window.getSelection();
	assert(selection !== null, "browser selection is available");
	selection.setBaseAndExtent(textNode, textNode.textContent?.length ?? 0, textNode, textNode.textContent?.length ?? 0);
	assert(document.execCommand("insertText", false, "!"), "browser performs a supported synthetic DOM input");
	line.textContent = "source A!";
	equal(line.textContent, "source A!", "synthetic native mutation is pending in the DOM");
	item.selectHandoff();
	equal(item.guard?.refreshGate(), false, "unobserved DOM mutation fails gate reconfiguration closed");
	equal(item.view.state.doc.toString(), "source A", "guard never synthesizes a full-document fallback");
	equal(item.intents.length, 0, "unobserved DOM bytes are not fabricated into an intent");
	equal(item.guard?.snapshot().gateFailureReason, "pending-input-not-flushable", "pending-input capability loss is explicit");
	destroy(item);

	const exact = fixture("source A");
	exact.beginHandoff();
	exact.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		inputType: "insertText",
		data: "!",
	}));
	const exactNative = exact.view.state.update({
		changes: { from: exact.view.state.doc.length, insert: "!" },
		selection: EditorSelection.cursor(exact.view.state.doc.length + 1),
		userEvent: "input.type",
		filter: false,
	});
	exact.view.dispatch(exactNative);
	const exactRoute = exact.intents[0] as RoutedHandoffInputIntent;
	equal(exactRoute.disposition, "replay-candidate", "normal exact non-IME input is explicitly replay-candidate");
	equal(exactRoute.reason, null, "normal exact non-IME input carries no manual reason");
	const exactIntent = exactRoute.intent;
	equal(exactIntent?.changes, exactNative.changes, "captured DOM input retains the exact native ChangeSet identity");
	equal(exactIntent?.selectionAfter, exactNative.newSelection, "captured DOM input retains the exact native selection identity");
	destroy(exact);
}

console.log("\n--- Browser Test 4a: virtualized documents do not impersonate pending native input ---");
{
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const longDocument = Array.from(
		{ length: 180 },
		(_, index) => `line-${String(index + 1).padStart(3, "0")}`,
	).join("\n");
	const view = new EditorView({ parent, doc: longDocument });
	const targetFile = file("B.md");
	const host = runtimeView(targetFile.path, longDocument);
	host.file = targetFile;
	let context: CodeMirrorHandoffContext = {
		kind: "same-path",
		sessionId: "virtualized-session",
		leafId: "virtualized-leaf",
		handoffGeneration: 1,
		path: "A.md",
	};
	const installed = installCodeMirrorHandoffGuard(view, {
		createId: (prefix) => `virtualized:${prefix}:1`,
		getCurrentContext: () => context,
		reserveManagedLeafInputStart: () => null,
		onHostLoadCandidate: () => true,
		onHostLoadCompleted: () => true,
		isExactHostStateReplacement: () => false,
		onInputIntent: () => true,
		isNativeHistoryReset: () => false,
		observeNativeHistoryReset: () => false,
		hashContent: (content) => content,
	});
	const renderedLines = view.contentDOM.querySelectorAll(":scope > .cm-line");
	assert(
		renderedLines.length > 0 && renderedLines.length < 180,
		"long CodeMirror document is represented by a virtualized DOM viewport",
	);
	assert(
		installed.kind === "installed",
		"empty observer evidence lets a normal virtualized document install the guard",
	);
	if (installed.kind === "installed") {
		const observer = (view as unknown as {
			observer: { forceFlush: () => unknown };
		}).observer;
		observer.forceFlush = () => undefined;
		const firstLine = renderedLines.item(0);
		firstLine.textContent = `${firstLine.textContent ?? ""}!`;
		context = {
			kind: "handoff",
			sessionId: "virtualized-session",
			leafId: "virtualized-leaf",
			handoffGeneration: 2,
			switchIntentSeq: 1,
			sourceUnloadReceiptId: "source-unload:virtualized:1",
			fromPath: "A.md",
			fromFileId: "file-a",
			targetPath: targetFile.path,
			targetFile,
			runtimeView: host,
			bindingEpoch: 1,
			editorRevisionBefore: 0,
		};
		equal(
			installed.guard.refreshGate(),
			false,
			"a pending long-document childList mutation still fails the gate closed",
		);
		equal(
			installed.guard.snapshot().gateFailureReason,
			"pending-input-not-flushable",
			"pending long-document mutation retains explicit failure evidence",
		);
	}
	view.destroy();
	parent.remove();
}

console.log("\n--- Browser Test 5: filter:false stale bytes never reach a ViewPlugin ---");
{
	const item = fixture("source A");
	item.beginHandoff();
	const context = item.currentHandoff();
	assert(item.guard?.armHostLoad({
		hostLoadTokenId: "host-sentinel-B",
		...context,
		incomingContent: "certified B",
	}) === true, "sentinel case arms the certified B host load");
	const certifiedB = item.view.state.update({
		changes: { from: 0, to: item.view.state.doc.length, insert: "certified B" },
		effects: item.resetHistory.of(true),
		filter: false,
	});
	item.host.data = "certified B";
	item.view.dispatch(certifiedB);
	const candidate = item.candidates[0];
	assert((await item.guard?.acceptHeldHostLoad({
		candidate: candidate as never,
		presentationPlanId: "sentinel-plan-B",
	}))?.kind === "accepted", "sentinel sees the certified B acceptance");
	item.view.dispatch({
		changes: { from: 0, to: item.view.state.doc.length, insert: "stale A" },
		filter: false,
	});
	equal(item.view.state.doc.toString(), "certified B", "stale filter:false replacement is rejected at the final boundary");
	equal(item.observedDocuments.length, 1, "sentinel sees one document transition");
	equal(item.observedDocuments[0], "certified B", "sentinel sees only certified B");
	destroy(item);
}

console.log("\n--- Browser Test 6: direct update and transaction batches cannot bypass ---");
{
	const item = fixture("certified B");
	item.beginHandoff();
	const stale = item.view.state.update({ changes: { from: 0, to: 11, insert: "stale A" }, filter: false });
	const invalidTail = stale.state.update({ changes: { from: 0, to: 7, insert: "tail" }, filter: false });
	item.view.update([stale, invalidTail]);
	equal(item.view.state.doc.toString(), "certified B", "direct update rejects a stale transaction and its invalid tail");
	item.view.dispatch([stale, invalidTail]);
	equal(item.view.state.doc.toString(), "certified B", "dispatch transaction arrays are equally fenced");
	destroy(item);
}

console.log("\n--- Browser Tests 7-8: current host load is held, then accepted losslessly ---");
{
	const item = fixture("source A");
	item.beginHandoff();
	const context = item.currentHandoff();
	assert(item.guard?.armHostLoad({
		hostLoadTokenId: "host-B",
		sessionId: context.sessionId,
		leafId: context.leafId,
		handoffGeneration: context.handoffGeneration,
		switchIntentSeq: context.switchIntentSeq,
		sourceUnloadReceiptId: context.sourceUnloadReceiptId,
		targetPath: context.targetPath,
		targetFile: context.targetFile,
		runtimeView: context.runtimeView,
		incomingContent: "certified B",
		bindingEpoch: context.bindingEpoch,
		editorRevisionBefore: context.editorRevisionBefore,
	}) === true, "exact Task 3 clear-load association arms once");
	const original = item.view.state.update({
		changes: { from: 0, to: item.view.state.doc.length, insert: "certified B" },
		selection: EditorSelection.cursor(4),
		effects: [item.resetHistory.of(true), item.arbitraryEffect.of("private-note-body")],
		annotations: item.arbitraryAnnotation.of("annotation-value"),
		scrollIntoView: true,
		filter: false,
	});
	item.host.data = "certified B";
	item.view.dispatch(original);
	equal(item.view.state.doc.toString(), "source A", "current host candidate is held before update");
	equal(item.host.data, "source A", "held host candidate restores the exact runtime cache");
	equal(item.candidates.length, 1, "held host candidate is routed one-shot to Task 3");
	const candidate = item.candidates[0];
	assert(candidate !== null && typeof candidate === "object" && "heldTransaction" in candidate, "candidate retains the held transaction");
	equal((candidate as { heldTransaction: Transaction }).heldTransaction, original, "candidate retains original Transaction identity");
	assert(
		!(candidate as unknown as { effectFingerprint: string }).effectFingerprint.includes("private-note-body"),
		"effect fingerprint is content-free",
	);
	const acceptance = item.guard?.acceptHeldHostLoad({
		candidate: candidate as never,
		presentationPlanId: "opaque-plan-B",
	});
	equal(item.completions.length, 0, "completion is not reported before observed settlement");
	const accepted = await acceptance;
	assert(accepted?.kind === "accepted", "exact current candidate and opaque plan are accepted once");
	equal((await item.guard?.acceptHeldHostLoad({
		candidate: candidate as never,
		presentationPlanId: "opaque-plan-B-again",
	}))?.kind, "rejected", "accepted host candidate cannot be consumed twice");
	item.view.dispatch({
		changes: { from: 0, to: item.view.state.doc.length, insert: "forged accepted bytes" },
		annotations: acceptedHostLoad.of({
			hostLoadTokenId: "host-B",
			sessionId: context.sessionId,
			handoffGeneration: context.handoffGeneration,
		}),
		filter: false,
	});
	equal(item.view.state.doc.toString(), "certified B", "exported provenance annotation cannot forge a second acceptance");
	equal(item.view.state.doc.toString(), "certified B", "accepted load applies certified B before observation returns");
	equal(item.host.data, "certified B", "accepted load commits the target runtime cache");
	equal(item.view.state.selection.main.head, 4, "accepted load preserves selection");
	const acceptedTransaction = item.observedTransactions.find((transaction) => transaction.annotation(acceptedHostLoad)?.hostLoadTokenId === "host-B");
	assert(acceptedTransaction !== undefined, "sentinel sees acceptedHostLoad provenance on the applied transaction");
	const historyEvidence = item.view.state.field(item.historyField);
	equal(historyEvidence.marker, "target-reset", "accepted clear replaces a non-empty source-A history marker");
	equal(historyEvidence.resetEpoch, 1, "accepted clear advances native history exactly once");
	equal(historyEvidence.resetTransaction, acceptedTransaction ?? null, "history reset evidence belongs to the exact accepted transaction");
	equal(historyEvidence.clearedSourceMarker, true, "history reset proves the prior source-A history was actually retired");
	equal(acceptedTransaction?.changes, original.changes, "accepted load preserves the exact ChangeSet");
	equal(acceptedTransaction?.effects[1], original.effects[1], "accepted load preserves arbitrary effects by identity");
	equal(acceptedTransaction?.annotation(item.arbitraryAnnotation), "annotation-value", "accepted load preserves arbitrary annotations");
	equal(acceptedTransaction?.scrollIntoView, true, "accepted load preserves scroll request");
	assert((accepted?.kind === "accepted" ? accepted.receipt.nativeHistoryEpoch : 0) > 0, "acceptance advances a fresh native-history epoch");
	equal(
		accepted?.kind === "accepted" ? accepted.receipt.targetScrollAnchor : null,
		(candidate as { proposedScrollAnchor: number | null }).proposedScrollAnchor,
		"receipt preserves the candidate's exact proposed scroll anchor",
	);
	const proposedScrollAnchor = (candidate as { proposedScrollAnchor: number | null }).proposedScrollAnchor;
	assert(
		proposedScrollAnchor === null
			|| (proposedScrollAnchor >= item.view.viewport.from && proposedScrollAnchor <= item.view.viewport.to),
		"measured target viewport visibly contains the proposed scroll anchor",
	);
	equal(
		item.routedTransactions.filter((transaction) => transaction.annotation(acceptedHostLoad)?.hostLoadTokenId === "host-B").length,
		1,
		"accepted host load traverses the configured dispatch route exactly once",
	);
	equal(item.completions.length, 1, "real host completion receipt routes to Task 3");
	destroy(item);
}

console.log("\n--- Browser Test 8-anchor: only the exact captured-input effect advances held authority ---");
{
	const captured = fixture("source A");
	captured.beginHandoff("B.md");
	const held = holdClearHostLoad(captured, "host-captured-input-anchor", "B bytes");
	const stateBeforeInput = captured.view.state;
	captured.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		inputType: "insertText",
		data: "!",
	}));
	const input = captured.view.state.update({
		changes: { from: captured.view.state.doc.length, insert: "!" },
		selection: EditorSelection.cursor(captured.view.state.doc.length + 1),
		userEvent: "input.type",
		filter: false,
	});
	captured.view.dispatch(input);
	equal(captured.view.state.doc.toString(), "source A", "captured post-selection input remains quarantined from source A");
	equal(captured.intents.length, 1, "captured post-selection input is delivered exactly once");
	assert(captured.view.state !== stateBeforeInput, "guard-owned capture advances CodeMirror state identity");
	captured.setRecoveryGateModel({
		state: "stored",
		message: "Waiting for a proven target before automatic apply…",
		actions: ["continue-without-automatic-apply"],
	});
	equal(captured.guard?.refreshGate(), true, "guard-owned recovery-panel refresh settles after captured input");
	equal((await captured.guard?.acceptHeldHostLoad({
		candidate: held.candidate as never,
		presentationPlanId: "captured-input-anchor-plan",
	}))?.kind, "accepted", "fresh target replan accepts the held load after exact capture and panel bookkeeping");
	equal(captured.view.state.doc.toString(), "B bytes", "accepted held load installs B after exact capture bookkeeping");
	destroy(captured);

	const hostRouted = fixture("source A");
	hostRouted.beginHandoff("B.md");
	const hostRoutedContext = hostRouted.currentHandoff();
	assert(hostRouted.guard?.armHostLoad({
		hostLoadTokenId: "host-routed-gate-anchor",
		...hostRoutedContext,
		incomingContent: "B bytes",
	}) === true, "host-routed gate case arms the exact state replacement");
	const hostRoutedTargetState = EditorState.create({
		doc: "B bytes",
		extensions: hostRouted.extensions,
	});
	hostRouted.host.data = "B bytes";
	hostRouted.withExactHostStateReplacement(() => {
		hostRouted.view.setState(hostRoutedTargetState);
	});
	const hostRoutedCandidate = hostRouted.candidates[0];
	assert(hostRoutedCandidate !== undefined, "host-routed state replacement retains one candidate");
	hostRouted.setBypassGuardUpdateBoundary(true);
	hostRouted.setRecoveryGateModel({
		state: "failed",
		message: "Interrupted input still needs a recovery choice.",
		actions: handoffRecoveryGateActions("failed"),
	});
	let nestedRecoveryRefresh = false;
	hostRouted.setRouteHooks({
		after: () => {
			if (nestedRecoveryRefresh) return;
			nestedRecoveryRefresh = true;
			hostRouted.setRecoveryGateModel({
				state: "stored",
				message: "Waiting for a proven target before automatic apply…",
				actions: ["continue-without-automatic-apply"],
			});
			equal(
				hostRouted.guard?.refreshGate(),
				true,
				"host update may synchronously request a second exact Recovery refresh",
			);
		},
	});
	equal(
		hostRouted.guard?.refreshGate(),
		true,
		"host-routed Recovery refresh applies its exact nested guard-owned transactions",
	);
	const hostRoutedAcceptance = await hostRouted.guard?.acceptHeldHostLoad({
		candidate: hostRoutedCandidate as never,
		presentationPlanId: "host-routed-gate-anchor-plan",
	});
	equal(
		hostRoutedAcceptance?.kind,
		"accepted",
		`exact guard-owned state advance survives a host route that captured update ` +
			`(failure=${String(hostRouted.guard?.snapshot().commitFailureReason)})`,
	);
	equal(hostRouted.view.state.doc.toString(), "B bytes", "host-routed authority still admits B once");
	destroy(hostRouted);

	const postDelegation = fixture("source A");
	postDelegation.beginHandoff("B.md");
	const postDelegationContext = postDelegation.currentHandoff();
	assert(postDelegation.guard?.armHostLoad({
		hostLoadTokenId: "host-post-delegation-anchor",
		...postDelegationContext,
		incomingContent: "B bytes",
	}) === true, "post-delegation case arms the exact host state replacement");
	postDelegation.host.data = "B bytes";
	postDelegation.withExactHostStateReplacement(() => {
		postDelegation.view.setState(EditorState.create({
			doc: "B bytes",
			extensions: postDelegation.extensions,
		}));
	});
	const postDelegationCandidate = postDelegation.candidates[0];
	assert(postDelegationCandidate !== undefined, "post-delegation case retains one host candidate");
	const sourceState = postDelegation.view.state;
	const metadataState = EditorState.create({
		doc: sourceState.doc,
		selection: sourceState.selection,
		extensions: postDelegation.extensions,
	});
	Reflect.apply(postDelegation.originalSetState, postDelegation.view, [metadataState]);
	assert(postDelegation.view.state !== sourceState, "captured host setState may install same-document metadata");
	equal(postDelegation.view.state.doc, sourceState.doc, "host metadata tail retains the exact source document object");
	equal(
		postDelegation.withExactHostPostDelegation(() =>
			postDelegation.guard?.certifyHostLoadPostDelegation(
				"host-post-delegation-anchor",
			)),
		true,
		"exact synchronous clear-load tail certifies same-document host metadata",
	);
	equal((await postDelegation.guard?.acceptHeldHostLoad({
		candidate: postDelegationCandidate as never,
		presentationPlanId: "host-post-delegation-anchor-plan",
	}))?.kind, "accepted", "certified same-document host metadata preserves held-load authority");
	equal(postDelegation.view.state.doc.toString(), "B bytes", "post-delegation certificate still admits only held B");
	destroy(postDelegation);

	const stateHostScroll = fixture("source A");
	stateHostScroll.beginHandoff("B.md");
	Object.defineProperty(stateHostScroll.view.scrollDOM, "scrollTop", {
		configurable: true,
		value: 560,
		writable: true,
	});
	const stateHostScrollContext = stateHostScroll.currentHandoff();
	assert(stateHostScroll.guard?.armHostLoad({
		hostLoadTokenId: "host-state-scroll-tail",
		...stateHostScrollContext,
		incomingContent: "B bytes",
	}) === true, "state host-scroll case arms the exact host state replacement");
	stateHostScroll.host.data = "B bytes";
	stateHostScroll.withExactHostStateReplacement(() => {
		stateHostScroll.view.setState(EditorState.create({
			doc: "B bytes",
			extensions: stateHostScroll.extensions,
		}));
	});
	const stateHostScrollCandidate = stateHostScroll.candidates[0];
	assert(stateHostScrollCandidate !== undefined, "state host-scroll case retains one host candidate");
	stateHostScroll.view.scrollDOM.scrollTop = 0;
	equal(
		stateHostScroll.withExactHostPostDelegation(() =>
			stateHostScroll.guard?.certifyHostLoadPostDelegation(
				"host-state-scroll-tail",
			)),
		true,
		"exact state-kind host tail may adopt its synchronous raw scroll reset",
	);
	equal((await stateHostScroll.guard?.acceptHeldHostLoad({
		candidate: stateHostScrollCandidate as never,
		presentationPlanId: "host-state-scroll-tail-plan",
	}))?.kind, "accepted", "certified state-kind host scroll reset preserves held-load authority");
	equal(stateHostScroll.view.state.doc.toString(), "B bytes", "state-kind host scroll adoption still admits only held B");
	destroy(stateHostScroll);

	const statePostInput = fixture("source A");
	statePostInput.beginHandoff("B.md");
	const statePostInputContext = statePostInput.currentHandoff();
	assert(statePostInput.guard?.armHostLoad({
		hostLoadTokenId: "host-state-post-input",
		...statePostInputContext,
		incomingContent: "B bytes",
	}) === true, "state post-input case arms the exact host state replacement");
	statePostInput.host.data = "B bytes";
	statePostInput.withExactHostStateReplacement(() => {
		statePostInput.view.setState(EditorState.create({
			doc: "B bytes",
			extensions: statePostInput.extensions,
		}));
	});
	const statePostInputCandidate = statePostInput.candidates[0];
	assert(statePostInputCandidate !== undefined, "state post-input case retains one host candidate");
	equal(
		statePostInput.withExactHostPostDelegation(() =>
			statePostInput.guard?.certifyHostLoadPostDelegation(
				"host-state-post-input",
			)),
		true,
		"state post-input case certifies the exact synchronous host tail",
	);
	const stateBeforeCapturedInput = statePostInput.view.state;
	statePostInput.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		inputType: "insertText",
		data: "!",
	}));
	statePostInput.view.dispatch(statePostInput.view.state.update({
		changes: { from: statePostInput.view.state.doc.length, insert: "!" },
		selection: EditorSelection.cursor(statePostInput.view.state.doc.length + 1),
		userEvent: "input.type",
		filter: false,
	}));
	equal(statePostInput.intents.length, 1, "state-kind captured input is delivered exactly once");
	assert(statePostInput.view.state !== stateBeforeCapturedInput, "state-kind captured input advances one guard-owned state identity");
	equal((await statePostInput.guard?.acceptHeldHostLoad({
		candidate: statePostInputCandidate as never,
		presentationPlanId: "host-state-post-input-plan",
	}))?.kind, "accepted", "state-kind held load survives its exact captured-input effect");
	equal(statePostInput.view.state.doc.toString(), "B bytes", "state-kind post-input acceptance still admits only held B");
	destroy(statePostInput);

	const statePriorHeldMissing = fixture("source A");
	statePriorHeldMissing.beginHandoff("B.md");
	completeReplayEligibleComposition(statePriorHeldMissing);
	equal(
		statePriorHeldMissing.guard?.snapshot().inputAuthorityAdvanceFailureReason,
		"held-missing",
		"a completed IME before any host candidate records no imaginary held authority",
	);
	const statePriorHeldMissingCandidate = holdStateHostLoad(
		statePriorHeldMissing,
		"host-state-after-prior-held-missing",
	);
	const priorHeldMissingNoop = statePriorHeldMissing.view.state.update({ filter: false });
	statePriorHeldMissing.view.dispatch(priorHeldMissingNoop);
	equal((await statePriorHeldMissing.guard?.acceptHeldHostLoad({
		candidate: statePriorHeldMissingCandidate as never,
		presentationPlanId: "host-state-after-prior-held-missing-plan",
	}))?.kind, "accepted", "a newly held candidate is not poisoned by an older held-missing observation");
	equal(
		statePriorHeldMissing.view.state.doc.toString(),
		"B bytes",
		"candidate-scoped authority reset still admits only the held target",
	);
	destroy(statePriorHeldMissing);

	const statePostCompositionNoop = fixture("source A");
	statePostCompositionNoop.beginHandoff("B.md");
	const statePostCompositionNoopContext = statePostCompositionNoop.currentHandoff();
	assert(statePostCompositionNoop.guard?.armHostLoad({
		hostLoadTokenId: "host-state-post-composition-noop",
		...statePostCompositionNoopContext,
		incomingContent: "B bytes",
	}) === true, "state post-composition no-op case arms the exact host state replacement");
	statePostCompositionNoop.host.data = "B bytes";
	statePostCompositionNoop.withExactHostStateReplacement(() => {
		statePostCompositionNoop.view.setState(EditorState.create({
			doc: "B bytes",
			extensions: statePostCompositionNoop.extensions,
		}));
	});
	const statePostCompositionNoopCandidate = statePostCompositionNoop.candidates[0];
	assert(statePostCompositionNoopCandidate !== undefined, "state post-composition no-op case retains one host candidate");
	equal(
		statePostCompositionNoop.withExactHostPostDelegation(() =>
			statePostCompositionNoop.guard?.certifyHostLoadPostDelegation(
				"host-state-post-composition-noop",
			)),
		true,
		"state post-composition no-op case certifies the exact synchronous host tail",
	);
	statePostCompositionNoop.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", {
		bubbles: true,
		data: "",
	}));
	statePostCompositionNoop.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate", {
		bubbles: true,
		data: "한",
	}));
	statePostCompositionNoop.view.dispatch(statePostCompositionNoop.view.state.update({
		changes: { from: statePostCompositionNoop.view.state.doc.length, insert: "한" },
		selection: EditorSelection.cursor(statePostCompositionNoop.view.state.doc.length + 1),
		userEvent: "input.type.compose",
		filter: false,
	}));
	statePostCompositionNoop.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", {
		bubbles: true,
		data: "한",
	}));
	equal(statePostCompositionNoop.intents.length, 1, "completed state-kind IME is delivered exactly once");
	await Promise.resolve();
	const beforeCompositionNoop = statePostCompositionNoop.view.state;
	const compositionNoop = beforeCompositionNoop.update({ filter: false });
	equal(compositionNoop.docChanged, false, "post-composition no-op changes no document bytes");
	equal(compositionNoop.effects.length, 0, "post-composition no-op carries no effects");
	equal(compositionNoop.selection, undefined, "post-composition no-op carries no selection update");
	statePostCompositionNoop.view.dispatch(compositionNoop);
	assert(
		statePostCompositionNoop.view.state !== beforeCompositionNoop,
		"post-composition no-op advances one otherwise identical state identity",
	);
	equal((await statePostCompositionNoop.guard?.acceptHeldHostLoad({
		candidate: statePostCompositionNoopCandidate as never,
		presentationPlanId: "host-state-post-composition-noop-plan",
	}))?.kind, "accepted", "state-kind held load survives one exact post-composition no-op");
	equal(
		statePostCompositionNoop.view.state.doc.toString(),
		"B bytes",
		"post-composition no-op admission still applies only the held target",
	);
	destroy(statePostCompositionNoop);

	const statePostCompositionGeometry = fixture("source A");
	statePostCompositionGeometry.beginHandoff("B.md");
	const statePostCompositionGeometryCandidate = holdStateHostLoad(
		statePostCompositionGeometry,
		"host-state-post-composition-geometry",
	);
	completeReplayEligibleComposition(statePostCompositionGeometry);
	equal(
		statePostCompositionGeometry.intents.length,
		1,
		"geometry-tail case delivers one exact IME intent",
	);
	const geometryParent = statePostCompositionGeometry.view.dom.parentElement;
	assert(geometryParent !== null, "geometry-tail case retains its mounted editor parent");
	geometryParent.style.width = "320px";
	statePostCompositionGeometry.view.requestMeasure();
	await new Promise<void>((resolve) => requestAnimationFrame(() =>
		requestAnimationFrame(() => resolve())
	));
	statePostCompositionGeometry.view.dispatch(
		statePostCompositionGeometry.view.state.update({ filter: false }),
	);
	equal((await statePostCompositionGeometry.guard?.acceptHeldHostLoad({
		candidate: statePostCompositionGeometryCandidate as never,
		presentationPlanId: "host-state-post-composition-geometry-plan",
	}))?.kind, "accepted", "transaction-free geometry preserves the one exact time-only settlement token");
	equal(
		statePostCompositionGeometry.view.state.doc.toString(),
		"B bytes",
		"geometry-tail admission still applies only the held target",
	);
	destroy(statePostCompositionGeometry);

	const statePostHostVoidEffect = fixture("source A");
	statePostHostVoidEffect.beginHandoff("B.md");
	const statePostHostVoidCandidate = holdStateHostLoad(
		statePostHostVoidEffect,
		"host-state-post-void-effect",
	);
	const beforeHostVoidEffect = statePostHostVoidEffect.view.state;
	const hostVoidEffect = beforeHostVoidEffect.update({
		effects: statePostHostVoidEffect.voidEffect.of(undefined),
		filter: false,
	});
	equal(hostVoidEffect.docChanged, false, "host void effect changes no document bytes");
	equal(hostVoidEffect.selection, undefined, "host void effect carries no selection update");
	equal(hostVoidEffect.scrollIntoView, false, "host void effect carries no scroll request");
	equal(hostVoidEffect.effects.length, 1, "host void effect carries one exact effect");
	equal(hostVoidEffect.effects[0]?.value, undefined, "host void effect has no persistent value");
	statePostHostVoidEffect.view.dispatch(hostVoidEffect);
	equal((await statePostHostVoidEffect.guard?.acceptHeldHostLoad({
		candidate: statePostHostVoidCandidate as never,
		presentationPlanId: "host-state-post-void-effect-plan",
	}))?.kind, "accepted", "one persistence-neutral host view effect advances held state identity");
	equal(
		statePostHostVoidEffect.view.state.doc.toString(),
		"B bytes",
		"persistence-neutral host view effect still admits only the held target",
	);
	destroy(statePostHostVoidEffect);

	const statePostGuardReconfiguration = fixture("source A");
	statePostGuardReconfiguration.beginHandoff("B.md");
	const statePostGuardReconfigurationCandidate = holdStateHostLoad(
		statePostGuardReconfiguration,
		"host-state-post-guard-reconfiguration",
	);
	statePostGuardReconfiguration.setRecoveryGateModel({
		state: "stored",
		message: "Waiting for a proven target before automatic apply…",
		actions: ["continue-without-automatic-apply"],
	});
	equal(
		statePostGuardReconfiguration.guard?.refreshGate(),
		true,
		"guard-owned recovery reconfiguration advances through its exact ledger",
	);
	statePostGuardReconfiguration.view.dispatch(
		statePostGuardReconfiguration.view.state.update({ filter: false }),
	);
	equal((await statePostGuardReconfiguration.guard?.acceptHeldHostLoad({
		candidate: statePostGuardReconfigurationCandidate as never,
		presentationPlanId: "host-state-post-guard-reconfiguration-plan",
	}))?.kind, "accepted", "guard-owned reconfiguration rebases one exact time-only tail");
	equal(
		statePostGuardReconfiguration.view.state.doc.toString(),
		"B bytes",
		"guard-owned reconfiguration and time tail still admit only the held target",
	);
	destroy(statePostGuardReconfiguration);

	const statePostValuedEffect = fixture("source A");
	statePostValuedEffect.beginHandoff("B.md");
	const statePostValuedCandidate = holdStateHostLoad(
		statePostValuedEffect,
		"host-state-post-valued-effect",
	);
	statePostValuedEffect.view.dispatch(statePostValuedEffect.view.state.update({
		effects: statePostValuedEffect.arbitraryEffect.of("persistent-value"),
		filter: false,
	}));
	equal((await statePostValuedEffect.guard?.acceptHeldHostLoad({
		candidate: statePostValuedCandidate as never,
		presentationPlanId: "host-state-post-valued-effect-plan",
	}))?.kind, "rejected", "a valued effect cannot impersonate a persistence-neutral host tail");
	equal(
		statePostValuedEffect.view.state.doc.toString(),
		"source A",
		"valued effect leaves the held target unapplied",
	);
	destroy(statePostValuedEffect);

	const statePreCompletionNoop = fixture("source A", true, true, [], (target) => {
		target.contentDOM.addEventListener("compositionend", () => {
			target.dispatch(target.state.update({ filter: false }));
		}, true);
	});
	statePreCompletionNoop.beginHandoff("B.md");
	const statePreCompletionNoopCandidate = holdStateHostLoad(
		statePreCompletionNoop,
		"host-state-pre-completion-noop",
	);
	completeReplayEligibleComposition(statePreCompletionNoop);
	equal(
		statePreCompletionNoop.intents.length,
		1,
		"pre-completion time-only case delivers one exact IME intent",
	);
	equal((await statePreCompletionNoop.guard?.acceptHeldHostLoad({
		candidate: statePreCompletionNoopCandidate as never,
		presentationPlanId: "host-state-pre-completion-noop-plan",
	}))?.kind, "accepted", "a proven IME may adopt its exact time-only state update observed before completion");
	equal(
		statePreCompletionNoop.view.state.doc.toString(),
		"B bytes",
		"pre-completion no-op adoption still applies only the held target",
	);
	destroy(statePreCompletionNoop);

	const statePostCompositionNoopSpent = fixture("source A");
	statePostCompositionNoopSpent.beginHandoff("B.md");
	const statePostCompositionNoopSpentCandidate = holdStateHostLoad(
		statePostCompositionNoopSpent,
		"host-state-post-composition-noop-spent",
	);
	completeReplayEligibleComposition(statePostCompositionNoopSpent);
	equal(
		statePostCompositionNoopSpent.intents.length,
		1,
		"one-shot post-composition case delivers one exact IME intent",
	);
	statePostCompositionNoopSpent.view.dispatch(
		statePostCompositionNoopSpent.view.state.update({ filter: false }),
	);
	statePostCompositionNoopSpent.view.dispatch(
		statePostCompositionNoopSpent.view.state.update({ filter: false }),
	);
	equal((await statePostCompositionNoopSpent.guard?.acceptHeldHostLoad({
		candidate: statePostCompositionNoopSpentCandidate as never,
		presentationPlanId: "host-state-post-composition-noop-spent-plan",
	}))?.kind, "rejected", "a second exact time-only no-op cannot reuse the one-shot settlement token");
	equal(
		statePostCompositionNoopSpent.view.state.doc.toString(),
		"source A",
		"spent settlement authority fails closed on the source document",
	);
	destroy(statePostCompositionNoopSpent);

	const statePostCompositionNoopInterrupted = fixture("source A");
	statePostCompositionNoopInterrupted.beginHandoff("B.md");
	const statePostCompositionNoopInterruptedCandidate = holdStateHostLoad(
		statePostCompositionNoopInterrupted,
		"host-state-post-composition-noop-interrupted",
	);
	completeReplayEligibleComposition(statePostCompositionNoopInterrupted);
	statePostCompositionNoopInterrupted.view.dispatch(
		statePostCompositionNoopInterrupted.view.state.update({
			annotations: statePostCompositionNoopInterrupted.arbitraryAnnotation.of("intervening"),
			filter: false,
		}),
	);
	statePostCompositionNoopInterrupted.view.dispatch(
		statePostCompositionNoopInterrupted.view.state.update({ filter: false }),
	);
	equal((await statePostCompositionNoopInterrupted.guard?.acceptHeldHostLoad({
		candidate: statePostCompositionNoopInterruptedCandidate as never,
		presentationPlanId: "host-state-post-composition-noop-interrupted-plan",
	}))?.kind, "rejected", "an intervening metadata update spends the token before a later time-only no-op");
	equal(
		statePostCompositionNoopInterrupted.view.state.doc.toString(),
		"source A",
		"interrupted settlement authority fails closed on the source document",
	);
	destroy(statePostCompositionNoopInterrupted);

	const stateSelectionSettlement = fixture("source A");
	stateSelectionSettlement.beginHandoff("B.md");
	const stateSelectionSettlementContext = stateSelectionSettlement.currentHandoff();
	assert(stateSelectionSettlement.guard?.armHostLoad({
		hostLoadTokenId: "host-state-selection-settlement",
		...stateSelectionSettlementContext,
		incomingContent: "B bytes",
	}) === true, "state selection-settlement case arms the exact host state replacement");
	stateSelectionSettlement.host.data = "B bytes";
	stateSelectionSettlement.withExactHostStateReplacement(() => {
		stateSelectionSettlement.view.setState(EditorState.create({
			doc: "B bytes",
			extensions: stateSelectionSettlement.extensions,
		}));
	});
	const stateSelectionSettlementCandidate = stateSelectionSettlement.candidates[0];
	assert(stateSelectionSettlementCandidate !== undefined, "state selection-settlement case retains one host candidate");
	equal(
		stateSelectionSettlement.withExactHostPostDelegation(() =>
			stateSelectionSettlement.guard?.certifyHostLoadPostDelegation(
				"host-state-selection-settlement",
			)),
		true,
		"state selection-settlement case certifies the exact synchronous host tail",
	);
	const selectionSettlementStartState = stateSelectionSettlement.view.state;
	const selectionSettlement = selectionSettlementStartState.update({
		selection: selectionSettlementStartState.selection,
		filter: false,
	});
	equal(selectionSettlement.docChanged, false, "selection settlement changes no document bytes");
	equal(selectionSettlement.effects.length, 0, "selection settlement carries no state effect");
	equal(
		selectionSettlement.selection,
		selectionSettlement.startState.selection,
		"selection settlement reuses the exact selection object",
	);
	equal(
		selectionSettlement.startState.selection.eq(selectionSettlement.newSelection),
		true,
		"selection settlement preserves the exact selection value",
	);
	stateSelectionSettlement.view.dispatch(selectionSettlement);
	assert(
		stateSelectionSettlement.view.state !== selectionSettlementStartState,
		"selection settlement advances one content-free state identity",
	);
	equal((await stateSelectionSettlement.guard?.acceptHeldHostLoad({
		candidate: stateSelectionSettlementCandidate as never,
		presentationPlanId: "host-state-selection-settlement-plan",
	}))?.kind, "accepted", "state-kind held load survives one exact same-selection history settlement");
	equal(stateSelectionSettlement.view.state.doc.toString(), "B bytes", "selection settlement still admits only held B");
	destroy(stateSelectionSettlement);

	const stateRepeatedSettlement = fixture("source A");
	stateRepeatedSettlement.beginHandoff("B.md");
	const stateRepeatedSettlementContext = stateRepeatedSettlement.currentHandoff();
	assert(stateRepeatedSettlement.guard?.armHostLoad({
		hostLoadTokenId: "host-state-repeated-settlement",
		...stateRepeatedSettlementContext,
		incomingContent: "B bytes",
	}) === true, "state repeated-settlement case arms the exact host state replacement");
	stateRepeatedSettlement.host.data = "B bytes";
	stateRepeatedSettlement.withExactHostStateReplacement(() => {
		stateRepeatedSettlement.view.setState(EditorState.create({
			doc: "B bytes",
			extensions: stateRepeatedSettlement.extensions,
		}));
	});
	const stateRepeatedSettlementCandidate = stateRepeatedSettlement.candidates[0];
	assert(stateRepeatedSettlementCandidate !== undefined, "state repeated-settlement case retains one host candidate");
	equal(
		stateRepeatedSettlement.withExactHostPostDelegation(() =>
			stateRepeatedSettlement.guard?.certifyHostLoadPostDelegation(
				"host-state-repeated-settlement",
			)),
		true,
		"state repeated-settlement case certifies the exact synchronous host tail",
	);
	for (let index = 0; index < 2; index += 1) {
		stateRepeatedSettlement.view.dispatch(stateRepeatedSettlement.view.state.update({
			selection: stateRepeatedSettlement.view.state.selection,
			filter: false,
		}));
	}
	equal((await stateRepeatedSettlement.guard?.acceptHeldHostLoad({
		candidate: stateRepeatedSettlementCandidate as never,
		presentationPlanId: "host-state-repeated-settlement-plan",
	}))?.kind, "rejected", "a second same-selection settlement cannot widen the one-shot authority window");
	equal(stateRepeatedSettlement.view.state.doc.toString(), "source A", "repeated settlement leaves held B unapplied");
	destroy(stateRepeatedSettlement);

	const stateFocusOnly = fixture("source A");
	stateFocusOnly.beginHandoff("B.md");
	const stateFocusOnlyContext = stateFocusOnly.currentHandoff();
	assert(stateFocusOnly.guard?.armHostLoad({
		hostLoadTokenId: "host-state-focus-only",
		...stateFocusOnlyContext,
		incomingContent: "B bytes",
	}) === true, "state focus-only case arms the exact host state replacement");
	stateFocusOnly.host.data = "B bytes";
	stateFocusOnly.withExactHostStateReplacement(() => {
		stateFocusOnly.view.setState(EditorState.create({
			doc: "B bytes",
			extensions: stateFocusOnly.extensions,
		}));
	});
	const stateFocusOnlyCandidate = stateFocusOnly.candidates[0];
	assert(stateFocusOnlyCandidate !== undefined, "state focus-only case retains one host candidate");
	equal(
		stateFocusOnly.withExactHostPostDelegation(() =>
			stateFocusOnly.guard?.certifyHostLoadPostDelegation("host-state-focus-only")),
		true,
		"state focus-only case certifies the exact synchronous host tail",
	);
	stateFocusOnly.view.focus();
	stateFocusOnly.view.dispatch(stateFocusOnly.view.state.update({ filter: false }));
	equal((await stateFocusOnly.guard?.acceptHeldHostLoad({
		candidate: stateFocusOnlyCandidate as never,
		presentationPlanId: "host-state-focus-only-plan",
	}))?.kind, "rejected", "focus-only metadata cannot impersonate the observed host selection settlement");
	equal(stateFocusOnly.view.state.doc.toString(), "source A", "focus-only settlement leaves held B unapplied");
	destroy(stateFocusOnly);

	const stateScrollEpochDrift = fixture("source A");
	stateScrollEpochDrift.beginHandoff("B.md");
	Object.defineProperty(stateScrollEpochDrift.view.scrollDOM, "scrollTop", {
		configurable: true,
		value: 560,
		writable: true,
	});
	const stateScrollEpochContext = stateScrollEpochDrift.currentHandoff();
	assert(stateScrollEpochDrift.guard?.armHostLoad({
		hostLoadTokenId: "host-state-scroll-epoch-drift",
		...stateScrollEpochContext,
		incomingContent: "B bytes",
	}) === true, "state scroll-epoch drift case arms the exact host state replacement");
	stateScrollEpochDrift.host.data = "B bytes";
	stateScrollEpochDrift.withExactHostStateReplacement(() => {
		stateScrollEpochDrift.view.setState(EditorState.create({
			doc: "B bytes",
			extensions: stateScrollEpochDrift.extensions,
		}));
	});
	stateScrollEpochDrift.view.scrollDOM.scrollTop = 0;
	stateScrollEpochDrift.view.scrollDOM.dispatchEvent(new Event("scroll"));
	equal(
		stateScrollEpochDrift.withExactHostPostDelegation(() =>
			stateScrollEpochDrift.guard?.certifyHostLoadPostDelegation(
				"host-state-scroll-epoch-drift",
			)),
		false,
		"state-kind raw scroll change with an observed scroll epoch remains fail closed",
	);
	equal(
		stateScrollEpochDrift.guard?.snapshot().hostPostDelegationFailureReason,
		"scroll-epoch",
		"state-kind scroll epoch drift retains its exact rejection reason",
	);
	destroy(stateScrollEpochDrift);

	const transactionHostScroll = fixture("source A");
	transactionHostScroll.beginHandoff("B.md");
	Object.defineProperty(transactionHostScroll.view.scrollDOM, "scrollTop", {
		configurable: true,
		value: 560,
		writable: true,
	});
	const transactionHostScrollHeld = holdClearHostLoad(
		transactionHostScroll,
		"host-transaction-scroll-tail",
		"B bytes",
	);
	transactionHostScroll.view.scrollDOM.scrollTop = 0;
	equal(
		transactionHostScroll.withExactHostPostDelegation(() =>
			transactionHostScroll.guard?.certifyHostLoadPostDelegation(
				"host-transaction-scroll-tail",
			)),
		false,
		"transaction-kind raw scroll change is not widened into state-kind host authority",
	);
	equal(
		transactionHostScroll.guard?.snapshot().hostPostDelegationFailureReason,
		"scroll-top",
		"transaction-kind raw scroll drift retains its exact rejection reason",
	);
	assert(
		transactionHostScrollHeld.candidate !== undefined,
		"transaction-kind counterexample retains its held candidate only for teardown",
	);
	destroy(transactionHostScroll);

	const uncertifiedPostDelegation = fixture("source A");
	uncertifiedPostDelegation.beginHandoff("B.md");
	const uncertifiedContext = uncertifiedPostDelegation.currentHandoff();
	assert(uncertifiedPostDelegation.guard?.armHostLoad({
		hostLoadTokenId: "host-uncertified-post-delegation",
		...uncertifiedContext,
		incomingContent: "B bytes",
	}) === true, "uncertified post-delegation case arms the exact host load");
	uncertifiedPostDelegation.host.data = "B bytes";
	uncertifiedPostDelegation.withExactHostStateReplacement(() => {
		uncertifiedPostDelegation.view.setState(EditorState.create({
			doc: "B bytes",
			extensions: uncertifiedPostDelegation.extensions,
		}));
	});
	const uncertifiedCandidate = uncertifiedPostDelegation.candidates[0];
	assert(uncertifiedCandidate !== undefined, "uncertified case retains one host candidate");
	const uncertifiedSourceState = uncertifiedPostDelegation.view.state;
	Reflect.apply(uncertifiedPostDelegation.originalSetState, uncertifiedPostDelegation.view, [
		EditorState.create({
			doc: uncertifiedSourceState.doc,
			selection: uncertifiedSourceState.selection,
			extensions: uncertifiedPostDelegation.extensions,
		}),
	]);
	equal(
		uncertifiedPostDelegation.guard?.certifyHostLoadPostDelegation(
			"host-uncertified-post-delegation",
		),
		false,
		"same-document state replacement outside the exact host call has no certificate",
	);
	equal((await uncertifiedPostDelegation.guard?.acceptHeldHostLoad({
		candidate: uncertifiedCandidate as never,
		presentationPlanId: "host-uncertified-post-delegation-plan",
	}))?.kind, "rejected", "uncertified same-document metadata remains fail closed");
	destroy(uncertifiedPostDelegation);

	const unrelated = fixture("source A");
	unrelated.beginHandoff("B.md");
	const unrelatedHeld = holdClearHostLoad(unrelated, "host-unrelated-effect-anchor", "B bytes");
	unrelated.view.dispatch(unrelated.view.state.update({
		annotations: unrelated.arbitraryAnnotation.of("unrelated-effect-only"),
		filter: false,
	}));
	equal((await unrelated.guard?.acceptHeldHostLoad({
		candidate: unrelatedHeld.candidate as never,
		presentationPlanId: "unrelated-effect-anchor-plan",
	}))?.kind, "rejected", "foreign effect-only state transition cannot advance held authority");
	equal(unrelated.view.state.doc.toString(), "source A", "foreign effect-only transition leaves held B bytes unapplied");
	equal(unrelated.intents.length, 0, "foreign effect-only transition cannot fabricate captured input");
	destroy(unrelated);

	const lookalike = fixture("source A");
	lookalike.beginHandoff("B.md");
	const lookalikeHeld = holdClearHostLoad(lookalike, "host-lookalike-gate-anchor", "B bytes");
	lookalike.view.dispatch(lookalike.view.state.update({
		effects: handoffGateCompartment.reconfigure(
			handoffGateClosedFacet.of(true),
		),
		filter: false,
	}));
	equal((await lookalike.guard?.acceptHeldHostLoad({
		candidate: lookalikeHeld.candidate as never,
		presentationPlanId: "lookalike-gate-anchor-plan",
	}))?.kind, "rejected", "foreign lookalike gate reconfiguration cannot inherit guard ownership");
	equal(lookalike.view.state.doc.toString(), "source A", "foreign lookalike gate transition leaves held B bytes unapplied");
	destroy(lookalike);
}

console.log("\n--- Browser Test 8a: failed runtime-cache CAS preserves the held candidate ---");
{
	const item = fixture("source A");
	item.beginHandoff();
	const context = item.currentHandoff();
	assert(item.guard?.armHostLoad({
		hostLoadTokenId: "host-cache-cas",
		...context,
		incomingContent: "certified B",
	}) === true, "cache-CAS case arms the exact host load");
	const hostLoad = item.view.state.update({
		changes: { from: 0, to: item.view.state.doc.length, insert: "certified B" },
		effects: item.resetHistory.of(true),
		filter: false,
	});
	item.host.data = "certified B";
	item.view.dispatch(hostLoad);
	const candidate = item.candidates[0];
	equal(item.guard?.refreshGate(), true, "idempotent closed-gate refresh succeeds without replacing editor state");
	equal(item.guard?.snapshot().pendingHostLoadCandidate, candidate as never, "idempotent refresh retains the exact current candidate");
	let cache = "source A";
	Object.defineProperty(item.host, "data", {
		configurable: true,
		get: () => cache,
		set: (value: string) => {
			if (value !== "certified B") cache = value;
		},
	});
	const refused = await item.guard?.acceptHeldHostLoad({
		candidate: candidate as never,
		presentationPlanId: "cache-cas-refused",
	});
	equal(refused?.kind, "rejected", "refusing runtime cache rejects acceptance");
	equal(item.guard?.snapshot().pendingHostLoadCandidate, candidate as never, "failed cache CAS retains the exact held candidate");
	equal(item.view.state.doc.toString(), "source A", "failed cache CAS performs no editor mutation");
	Object.defineProperty(item.host, "data", {
		configurable: true,
		writable: true,
		value: "source A",
	});
	equal((await item.guard?.acceptHeldHostLoad({
		candidate: candidate as never,
		presentationPlanId: "cache-cas-retry",
	}))?.kind, "accepted", "same candidate remains eligible after cache capability recovers");
	destroy(item);
}

console.log("\n--- Browser Test 8aa: runtime cache CAS uses only exact own data descriptors ---");
{
	const malicious = fixture("source A");
	malicious.beginHandoff("B.md");
	const maliciousContext = malicious.currentHandoff();
	assert(malicious.guard?.armHostLoad({
		hostLoadTokenId: "host-malicious-cache-setter",
		...maliciousContext,
		incomingContent: "certified B",
	}) === true, "malicious-setter case arms while runtime cache is still an exact own data property");
	const maliciousTransaction = malicious.view.state.update({
		changes: { from: 0, to: malicious.view.state.doc.length, insert: "certified B" },
		effects: malicious.resetHistory.of(true),
		filter: false,
	});
	malicious.host.data = "certified B";
	let maliciousCache = "certified B";
	let maliciousGetterCalls = 0;
	let maliciousSetterCalls = 0;
	const maliciousTargetC = file("C.md");
	Object.defineProperty(malicious.host, "data", {
		configurable: true,
		enumerable: true,
		get(): string {
			maliciousGetterCalls += 1;
			return maliciousCache;
		},
		set(value: string) {
			maliciousSetterCalls += 1;
			maliciousCache = value;
			malicious.host.file = maliciousTargetC;
		},
	});
	malicious.view.dispatch(maliciousTransaction);
	equal(maliciousGetterCalls, 0, "hold-time cache validation never invokes an accessor getter");
	equal(maliciousSetterCalls, 0, "hold-time cache rollback never invokes a malicious setter");
	equal(maliciousCache, "certified B", "unprovable accessor cache bytes remain unchanged");
	equal(malicious.host.file, maliciousContext.targetFile, "unprovable accessor cache cannot supersede B with C");
	equal(malicious.candidates.length, 0, "unprovable accessor cache produces no held candidate");
	equal(malicious.view.state.doc.toString(), "source A", "unprovable accessor cache applies no target bytes");
	destroy(malicious);

	const inherited = fixture("source A");
	inherited.beginHandoff("B.md");
	let inheritedGetterCalls = 0;
	let inheritedSetterCalls = 0;
	Reflect.deleteProperty(inherited.host as object, "data");
	Object.setPrototypeOf(inherited.host, Object.create(Object.getPrototypeOf(inherited.host), {
		data: {
			configurable: true,
			get(): string {
				inheritedGetterCalls += 1;
				return "source A";
			},
			set(): void {
				inheritedSetterCalls += 1;
			},
		},
	}));
	const inheritedContext = inherited.currentHandoff();
	equal(inherited.guard?.armHostLoad({
		hostLoadTokenId: "host-inherited-cache",
		...inheritedContext,
		incomingContent: "certified B",
	}), false, "inherited runtime cache property fails closed during arm");
	equal(inheritedGetterCalls, 0, "arm validation never invokes an inherited getter");
	equal(inheritedSetterCalls, 0, "arm validation never invokes an inherited setter");
	equal(inherited.host.file, inheritedContext.targetFile, "inherited cache rejection preserves exact target file identity");
	equal(inherited.view.state.doc.toString(), "source A", "inherited cache rejection applies no editor bytes");
	destroy(inherited);

	const exactDescriptor = fixture("source A");
	Object.defineProperty(exactDescriptor.host, "data", {
		configurable: false,
		enumerable: false,
		writable: true,
		value: "source A",
	});
	exactDescriptor.beginHandoff("B.md");
	const exactHeld = holdClearHostLoad(exactDescriptor, "host-own-data-descriptor");
	const heldDescriptor = Object.getOwnPropertyDescriptor(exactDescriptor.host, "data");
	assert(heldDescriptor !== undefined && "value" in heldDescriptor, "held cache remains an exact own data descriptor");
	equal(heldDescriptor?.value, "source A", "hold rollback atomically restores source cache bytes");
	equal(heldDescriptor?.configurable, false, "hold rollback preserves non-configurable flag");
	equal(heldDescriptor?.enumerable, false, "hold rollback preserves enumerable flag");
	equal(heldDescriptor?.writable, true, "hold rollback preserves writable flag");
	const exactResult = await probeAcceptance(exactDescriptor.guard?.acceptHeldHostLoad({
		candidate: exactHeld.candidate as never,
		presentationPlanId: "own-data-descriptor-plan",
	}));
	equal(exactResult.kind, "accepted", "writable non-configurable own data cache supports exact acceptance CAS");
	const acceptedDescriptor = Object.getOwnPropertyDescriptor(exactDescriptor.host, "data");
	assert(acceptedDescriptor !== undefined && "value" in acceptedDescriptor, "accepted cache remains an exact own data descriptor");
	equal(acceptedDescriptor?.value, "certified B", "acceptance atomically commits target cache bytes");
	equal(acceptedDescriptor?.configurable, false, "acceptance preserves non-configurable flag");
	equal(acceptedDescriptor?.enumerable, false, "acceptance preserves enumerable flag");
	equal(acceptedDescriptor?.writable, true, "acceptance preserves writable flag");
	destroy(exactDescriptor);
}

console.log("\n--- Browser Test 8ab: Task 3 candidate and completion delivery are explicit ACK protocols ---");
{
	for (const deliveryMode of ["reject", "throw"] as const) {
		const item = fixture("source A");
		item.beginHandoff();
		item.setCandidateDelivery(deliveryMode);
		const context = item.currentHandoff();
		const token = `candidate-${deliveryMode}`;
		assert(item.guard?.armHostLoad({
			hostLoadTokenId: token,
			...context,
			incomingContent: "certified B",
		}) === true, `${deliveryMode} candidate delivery arms the exact host load`);
		const transaction = item.view.state.update({
			changes: { from: 0, to: item.view.state.doc.length, insert: "certified B" },
			effects: item.resetHistory.of(true),
			filter: false,
		});
		item.host.data = "certified B";
		let escaped = false;
		try {
			item.view.dispatch(transaction);
		} catch {
			escaped = true;
		}
		equal(escaped, false, `${deliveryMode} candidate callback failure is contained at the guard boundary`);
		const candidate = item.candidates[0];
		assert(candidate !== undefined, `${deliveryMode} candidate failure retains the exact held candidate`);
		const presentationPlanId = `candidate-${deliveryMode}-plan`;
		const pending = await probeAcceptance(item.guard?.acceptHeldHostLoad({
			candidate: candidate as never,
			presentationPlanId,
		}));
		equal(pending.kind, "pending-notification", `${deliveryMode} candidate failure remains pending instead of committing`);
		equal(pending.notification, "candidate", `${deliveryMode} pending result identifies candidate notification`);
		equal(item.view.state.doc.toString(), "source A", `${deliveryMode} candidate failure performs no editor mutation`);
		equal(item.guard?.snapshot().commitState, "pending", `${deliveryMode} candidate failure does not burn the commit token`);
		equal(item.guard?.snapshot().pendingHostLoadCandidate, candidate as never, `${deliveryMode} candidate failure retains exact pending identity`);
		item.setCandidateDelivery("acknowledge");
		const accepted = await probeAcceptance(item.guard?.acceptHeldHostLoad({
			candidate: candidate as never,
			presentationPlanId,
		}));
		equal(accepted.kind, "accepted", `${deliveryMode} candidate retry commits after explicit ACK`);
		assert(item.candidates.length === 3 && item.candidates.every((attempt) => attempt === candidate), `${deliveryMode} candidate redelivery reuses one exact object identity`);
		equal(
			item.routedTransactions.filter((routed) => routed.annotation(acceptedHostLoad)?.hostLoadTokenId === token).length,
			1,
			`${deliveryMode} candidate retry applies the host transaction exactly once`,
		);
		destroy(item);
	}

	for (const deliveryMode of ["reject", "throw"] as const) {
		const item = fixture("source A");
		item.beginHandoff();
		const token = `completion-${deliveryMode}`;
		const held = holdClearHostLoad(item, token);
		item.setCompletionDelivery(deliveryMode);
		const presentationPlanId = `completion-${deliveryMode}-plan`;
		const first = await probeAcceptance(item.guard?.acceptHeldHostLoad({
			candidate: held.candidate as never,
			presentationPlanId,
		}));
		equal(first.kind, "pending-notification", `${deliveryMode} completion failure retains committed notification state`);
		equal(first.notification, "completion", `${deliveryMode} pending result identifies completion notification`);
		equal(item.view.state.doc.toString(), "certified B", `${deliveryMode} completion failure retains the committed target bytes`);
		equal(item.guard?.snapshot().commitState, "committed", `${deliveryMode} completion failure is terminally committed`);
		const receipt = item.completions[0];
		assert(receipt !== undefined && first.receipt === receipt, `${deliveryMode} pending completion exposes the exact delivered receipt`);
		const wrongPlan = await probeAcceptance(item.guard?.acceptHeldHostLoad({
			candidate: held.candidate as never,
			presentationPlanId: `${presentationPlanId}-different`,
		}));
		equal(wrongPlan.kind, "rejected", `${deliveryMode} committed receipt rejects a different presentation plan`);
		const clonedCandidate = { ...(held.candidate as object) };
		const staleCandidate = await probeAcceptance(item.guard?.acceptHeldHostLoad({
			candidate: clonedCandidate as never,
			presentationPlanId,
		}));
		equal(staleCandidate.kind, "rejected", `${deliveryMode} committed receipt rejects a merely equal candidate object`);
		const stillPending = await probeAcceptance(item.guard?.acceptHeldHostLoad({
			candidate: held.candidate as never,
			presentationPlanId,
		}));
		equal(stillPending.kind, "pending-notification", `${deliveryMode} same-plan retry only redelivers the retained receipt`);
		assert(item.completions.length === 2 && item.completions.every((attempt) => attempt === receipt), `${deliveryMode} failed completion redelivery preserves receipt identity and ID`);
		item.setCompletionDelivery("acknowledge");
		const acknowledged = await probeAcceptance(item.guard?.acceptHeldHostLoad({
			candidate: held.candidate as never,
			presentationPlanId,
		}));
		equal(acknowledged.kind, "accepted", `${deliveryMode} completion retry finishes after explicit ACK`);
		equal(acknowledged.receipt, receipt, `${deliveryMode} completion ACK returns the original receipt object`);
		assert(item.completions.length === 3 && item.completions.every((attempt) => attempt === receipt), `${deliveryMode} completion ACK never regenerates a receipt`);
		equal(
			item.routedTransactions.filter((routed) => routed.annotation(acceptedHostLoad)?.hostLoadTokenId === token).length,
			1,
			`${deliveryMode} completion retries never reapply the host transaction`,
		);
		destroy(item);
	}

	const candidateReentrant = fixture("source A");
	candidateReentrant.beginHandoff();
	const candidatePlan = "candidate-reentrant-plan";
	let nestedCandidateAcceptance: Promise<unknown> | undefined;
	candidateReentrant.setCandidateDeliveryHook((candidate, depth) => {
		if (depth !== 1) return;
		nestedCandidateAcceptance = candidateReentrant.guard?.acceptHeldHostLoad({
			candidate: candidate as never,
			presentationPlanId: candidatePlan,
		});
	});
	const candidateHeld = holdClearHostLoad(candidateReentrant, "host-candidate-reentrant");
	candidateReentrant.setCandidateDeliveryHook(null);
	const nestedCandidateResult = await probeAcceptance(nestedCandidateAcceptance);
	equal(candidateReentrant.candidateCallbackMaxDepth(), 1, "candidate callback reentry never recursively invokes candidate delivery");
	equal(candidateReentrant.candidates.length, 1, "candidate callback reentry observes one exact candidate delivery");
	equal(nestedCandidateResult.kind, "pending-notification", "nested candidate acceptance returns explicit pending notification");
	equal(nestedCandidateResult.notification, "candidate", "nested candidate acceptance identifies the in-flight candidate notification");
	equal(candidateReentrant.view.state.doc.toString(), "source A", "nested candidate acceptance performs no editor mutation");
	equal(
		candidateReentrant.routedTransactions.filter((routed) => routed.annotation(acceptedHostLoad)?.hostLoadTokenId === "host-candidate-reentrant").length,
		0,
		"nested candidate acceptance dispatches no accepted transaction",
	);
	const candidateOuterResult = await probeAcceptance(candidateReentrant.guard?.acceptHeldHostLoad({
		candidate: candidateHeld.candidate as never,
		presentationPlanId: candidatePlan,
	}));
	equal(candidateOuterResult.kind, "accepted", "later exact candidate acceptance commits after outer ACK finishes");
	equal(
		candidateReentrant.routedTransactions.filter((routed) => routed.annotation(acceptedHostLoad)?.hostLoadTokenId === "host-candidate-reentrant").length,
		1,
		"candidate reentry path commits the accepted transaction exactly once",
	);
	destroy(candidateReentrant);

	const completionReentrant = fixture("source A");
	completionReentrant.beginHandoff();
	const completionHeld = holdClearHostLoad(completionReentrant, "host-completion-reentrant");
	const completionPlan = "completion-reentrant-plan";
	completionReentrant.setCompletionDelivery("reject");
	let nestedCompletionAcceptance: Promise<unknown> | undefined;
	completionReentrant.setCompletionDeliveryHook((_receipt, depth) => {
		if (depth !== 1) return;
		nestedCompletionAcceptance = completionReentrant.guard?.acceptHeldHostLoad({
			candidate: completionHeld.candidate as never,
			presentationPlanId: completionPlan,
		});
	});
	const completionOuterPending = await probeAcceptance(completionReentrant.guard?.acceptHeldHostLoad({
		candidate: completionHeld.candidate as never,
		presentationPlanId: completionPlan,
	}));
	completionReentrant.setCompletionDeliveryHook(null);
	const nestedCompletionResult = await probeAcceptance(nestedCompletionAcceptance);
	equal(completionReentrant.completionCallbackMaxDepth(), 1, "completion callback reentry never recursively invokes receipt delivery");
	equal(completionReentrant.completions.length, 1, "completion callback reentry delivers one frozen receipt while outer delivery is active");
	equal(completionOuterPending.kind, "pending-notification", "outer failed completion delivery remains explicitly pending");
	equal(nestedCompletionResult.kind, "pending-notification", "nested completion retry returns explicit pending notification");
	equal(nestedCompletionResult.notification, "completion", "nested completion retry identifies the in-flight receipt notification");
	equal(nestedCompletionResult.receipt, completionReentrant.completions[0], "nested completion retry exposes the same frozen receipt");
	equal(
		completionReentrant.routedTransactions.filter((routed) => routed.annotation(acceptedHostLoad)?.hostLoadTokenId === "host-completion-reentrant").length,
		1,
		"nested completion retry never reapplies the committed transaction",
	);
	const reentrantReceipt = completionReentrant.completions[0];
	completionReentrant.setCompletionDelivery("acknowledge");
	const completionAcknowledged = await probeAcceptance(completionReentrant.guard?.acceptHeldHostLoad({
		candidate: completionHeld.candidate as never,
		presentationPlanId: completionPlan,
	}));
	equal(completionAcknowledged.kind, "accepted", "same exact completion retries only after failed outer delivery finishes");
	assert(completionReentrant.completions.length === 2 && completionReentrant.completions.every((receipt) => receipt === reentrantReceipt), "completion reentry retry preserves one frozen receipt identity");
	equal(
		completionReentrant.routedTransactions.filter((routed) => routed.annotation(acceptedHostLoad)?.hostLoadTokenId === "host-completion-reentrant").length,
		1,
		"completion reentry retry leaves committed work exactly once",
	);
	destroy(completionReentrant);

	const completionAuthorityMutations = [
		{
			name: "generation drift",
			mutate(item: Fixture, context: Extract<CodeMirrorHandoffContext, { kind: "handoff" }>): () => void {
				item.setContext({ ...context, handoffGeneration: context.handoffGeneration + 1 });
				return () => item.setContext(context);
			},
		},
		{
			name: "same-looking TFile replacement",
			mutate(item: Fixture, context: Extract<CodeMirrorHandoffContext, { kind: "handoff" }>): () => void {
				const replacement = file(context.targetPath);
				item.host.file = replacement;
				item.setContext({ ...context, targetFile: replacement });
				return () => {
					item.host.file = context.targetFile;
					item.setContext(context);
				};
			},
		},
		{
			name: "runtime cache replacement",
			mutate(item: Fixture, context: Extract<CodeMirrorHandoffContext, { kind: "handoff" }>): () => void {
				const descriptor = Object.getOwnPropertyDescriptor(item.host, "data");
				assert(descriptor !== undefined && "value" in descriptor, "runtime cache mutation starts from an exact own data descriptor");
				Object.defineProperty(item.host, "data", { ...descriptor, value: "superseding cache bytes" });
				return () => Object.defineProperty(item.host, "data", { ...descriptor, value: "certified B" });
			},
		},
	] as const;
	for (const authorityMutation of completionAuthorityMutations) {
		const item = fixture("source A");
		item.beginHandoff("B.md");
		const token = `completion-authority-${authorityMutation.name}`;
		const held = holdClearHostLoad(item, token);
		const presentationPlanId = `${token}-plan`;
		item.setCompletionDelivery("acknowledge");
		let restoreAuthority: (() => void) | undefined;
		let nestedAcceptance: Promise<unknown> | undefined;
		item.setCompletionDeliveryHook((_receipt, depth) => {
			if (depth !== 1) return;
			restoreAuthority = authorityMutation.mutate(item, held.context);
			nestedAcceptance = item.guard?.acceptHeldHostLoad({
				candidate: held.candidate as never,
				presentationPlanId,
			});
		});
		const outerResult = await probeAcceptance(item.guard?.acceptHeldHostLoad({
			candidate: held.candidate as never,
			presentationPlanId,
		}));
		item.setCompletionDeliveryHook(null);
		const nestedResult = await probeAcceptance(nestedAcceptance);
		equal(nestedResult.kind, "rejected", `${authorityMutation.name}: nested completion retry rejects superseded authority without redelivery`);
		equal(outerResult.kind, "rejected", `${authorityMutation.name}: callback ACK cannot accept a superseded completion target`);
		equal(item.guard?.snapshot().commitState, "failed", `${authorityMutation.name}: stale post-callback authority becomes terminally failed`);
		equal(item.completionCallbackMaxDepth(), 1, `${authorityMutation.name}: authority mutation never recursively delivers the receipt`);
		equal(item.completions.length, 1, `${authorityMutation.name}: stale completion receipt is attempted exactly once`);
		equal(
			item.routedTransactions.filter((routed) => routed.annotation(acceptedHostLoad)?.hostLoadTokenId === token).length,
			1,
			`${authorityMutation.name}: callback mutation never reapplies committed editor work`,
		);
		restoreAuthority?.();
		const restoredRetry = await probeAcceptance(item.guard?.acceptHeldHostLoad({
			candidate: held.candidate as never,
			presentationPlanId,
		}));
		equal(restoredRetry.kind, "rejected", `${authorityMutation.name}: restoring authority cannot revive the failed completion token`);
		equal(item.completions.length, 1, `${authorityMutation.name}: fail-closed retry cannot duplicate the stale receipt`);
		destroy(item);
	}
}

console.log("\n--- Browser Test 8b: host-load commit lifecycle retries only a proven no-mutation failure ---");
{
	const beforeThrow = fixture("source A");
	beforeThrow.beginHandoff();
	const held = holdClearHostLoad(beforeThrow, "host-route-before");
	beforeThrow.setRouteHooks({ before: () => { throw new Error("route-before-update"); } });
	const beforeResult = await beforeThrow.guard?.acceptHeldHostLoad({
		candidate: held.candidate as never,
		presentationPlanId: "route-before-plan",
	});
	equal(beforeResult?.kind, "rejected", "throw-before-update is surfaced as a rejected commit");
	equal(beforeThrow.view.state.doc.toString(), "source A", "throw-before-update leaves the editor untouched");
	equal(beforeThrow.host.data, "source A", "throw-before-update rolls back only the exact B cache CAS");
	equal(beforeThrow.guard?.snapshot().commitState, "pending", "exact no-mutation failure remains pending for retry");
	equal(beforeThrow.guard?.snapshot().pendingHostLoadCandidate, held.candidate as never, "retry retains the exact held candidate");
	beforeThrow.setRouteHooks({});
	equal((await beforeThrow.guard?.acceptHeldHostLoad({
		candidate: held.candidate as never,
		presentationPlanId: "route-before-retry",
	}))?.kind, "accepted", "the same candidate retries after a proven no-mutation failure");
	destroy(beforeThrow);

	const afterThrow = fixture("source A");
	afterThrow.beginHandoff();
	const applied = holdClearHostLoad(afterThrow, "host-route-after");
	afterThrow.setRouteHooks({ after: () => { throw new Error("route-after-update"); } });
	const afterResult = await afterThrow.guard?.acceptHeldHostLoad({
		candidate: applied.candidate as never,
		presentationPlanId: "route-after-plan",
	});
	equal(afterResult?.kind, "rejected", "throw-after-update is fail-closed instead of escaping");
	equal(afterThrow.view.state.doc.toString(), "certified B", "throw-after-update is recognized as a partial commit");
	equal(afterThrow.completions.length, 0, "partial commit never emits a completion receipt");
	equal(afterThrow.guard?.snapshot().commitState, "failed", "partial commit becomes terminally failed");
	afterThrow.setRouteHooks({});
	equal((await afterThrow.guard?.acceptHeldHostLoad({
		candidate: applied.candidate as never,
		presentationPlanId: "route-after-retry",
	}))?.kind, "rejected", "a partial commit is never dispatched a second time");
	destroy(afterThrow);
}

console.log("\n--- Browser Test 8c: settlement is measured from the exact target, history, and viewport ---");
{
	const missingHistory = fixture("source A");
	missingHistory.beginHandoff();
	const held = holdClearHostLoad(missingHistory, "host-history-observation");
	missingHistory.setHistorySettlementObserved(false);
	const result = await missingHistory.guard?.acceptHeldHostLoad({
		candidate: held.candidate as never,
		presentationPlanId: "missing-history-plan",
	});
	equal(result?.kind, "rejected", "missing observed native-history reset rejects settlement");
	equal(missingHistory.completions.length, 0, "unobserved history never emits a synthesized receipt");
	equal(missingHistory.guard?.snapshot().commitState, "failed", "failed postcondition is terminal after mutation");
	destroy(missingHistory);

	const noOpHistory = fixture("source A");
	noOpHistory.beginHandoff();
	noOpHistory.setHistoryResetBehavior("noop");
	const noOpHeld = holdClearHostLoad(noOpHistory, "host-history-noop");
	const noOpResult = await probeAcceptance(noOpHistory.guard?.acceptHeldHostLoad({
		candidate: noOpHeld.candidate as never,
		presentationPlanId: "history-noop-plan",
	}));
	equal(noOpResult.kind, "rejected", "a reset effect that leaves source-A history unchanged rejects settlement");
	equal(noOpHistory.completions.length, 0, "no-op history reset yields no completion receipt");
	equal(noOpHistory.guard?.snapshot().commitState, "failed", "no-op history reset is terminal after target bytes applied");
	destroy(noOpHistory);

	const alreadyEmptyHistory = fixture("source A", true, false);
	alreadyEmptyHistory.beginHandoff();
	const emptyHeld = holdClearHostLoad(alreadyEmptyHistory, "host-history-already-empty");
	const emptyResult = await probeAcceptance(alreadyEmptyHistory.guard?.acceptHeldHostLoad({
		candidate: emptyHeld.candidate as never,
		presentationPlanId: "history-already-empty-plan",
	}));
	equal(emptyResult.kind, "rejected", "an already-empty history cannot masquerade as retiring source-A history");
	equal(alreadyEmptyHistory.completions.length, 0, "already-empty history yields no completion receipt");
	equal(alreadyEmptyHistory.guard?.snapshot().commitState, "failed", "already-empty history proof fails terminally after mutation");
	destroy(alreadyEmptyHistory);

	const replacement = fixture("source A");
	replacement.beginHandoff("B.md");
	const original = holdClearHostLoad(replacement, "host-settlement-replacement", "B bytes");
	const acceptance = replacement.guard?.acceptHeldHostLoad({
		candidate: original.candidate as never,
		presentationPlanId: "settlement-replacement-plan",
	});
	const otherB = file("B.md");
	replacement.host.file = otherB;
	replacement.setContext({ ...original.context, targetFile: otherB });
	const replacementResult = await acceptance;
	equal(replacementResult?.kind, "rejected", "same-path TFile replacement before measure rejects settlement");
	equal(replacement.completions.length, 0, "replacement TFile cannot inherit the original receipt");
	equal(replacement.guard?.snapshot().commitState, "failed", "settlement target drift is terminal after mutation");
	destroy(replacement);
}

console.log("\n--- Browser Test 8ca: destroy and inert teardown settle an in-flight measurement ---");
{
	const destroyed = fixture("source A");
	destroyed.beginHandoff();
	const destroyedHeld = holdClearHostLoad(destroyed, "host-measure-destroy");
	const destroyedMeasure = deferMeasurements(destroyed);
	const destroyedAcceptance = destroyed.guard?.acceptHeldHostLoad({
		candidate: destroyedHeld.candidate as never,
		presentationPlanId: "measure-destroy-plan",
	});
	assert(destroyedMeasure.request() !== null, "destroy cancellation intercepts the in-flight settlement measure");
	destroyed.view.destroy();
	equal(destroyed.view.dispatch, destroyed.originalDispatch, "destroy restores the exact pre-install dispatch descriptor");
	equal(destroyed.view.update, destroyed.originalUpdate, "destroy restores the exact pre-install update descriptor");
	equal(destroyed.view.setState, destroyed.originalSetState, "destroy restores the exact pre-install setState descriptor");
	equal(destroyed.view.destroy, destroyed.originalDestroy, "destroy restores the exact pre-install destroy descriptor");
	const destroyedImmediate = await Promise.race([
		probeAcceptance(destroyedAcceptance),
		new Promise<AcceptanceProbe>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 0)),
	]);
	equal(destroyedImmediate.kind, "rejected", "destroy settles in-flight acceptance without waiting for a measure callback");
	equal(destroyed.guard?.snapshot().commitState, "failed", "destroy after applied commit records terminal failure");
	equal(destroyed.completions.length, 0, "destroyed commit emits no completion receipt");
	runDeferredMeasure(destroyedMeasure.request(), destroyed.view);
	const destroyedFinal = await Promise.race([
		probeAcceptance(destroyedAcceptance),
		new Promise<AcceptanceProbe>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 0)),
	]);
	equal(destroyedFinal.kind, "rejected", "late destroyed-view measure cannot revive acceptance");
	equal(destroyed.completions.length, 0, "late destroyed-view measure emits no receipt");
	destroyed.parent.remove();

	const inert = fixture("source A");
	inert.beginHandoff();
	const inertHeld = holdClearHostLoad(inert, "host-measure-inert");
	const inertMeasure = deferMeasurements(inert);
	const inertAcceptance = inert.guard?.acceptHeldHostLoad({
		candidate: inertHeld.candidate as never,
		presentationPlanId: "measure-inert-plan",
	});
	assert(inertMeasure.request() !== null, "markInert cancellation intercepts the in-flight settlement measure");
	equal(inert.guard?.markInert(), true, "markInert cancels and settles an in-flight host-load measure");
	const inertImmediate = await Promise.race([
		probeAcceptance(inertAcceptance),
		new Promise<AcceptanceProbe>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 0)),
	]);
	equal(inertImmediate.kind, "rejected", "markInert settles in-flight acceptance without waiting for the measure callback");
	equal(inert.guard?.snapshot().commitState, "failed", "markInert after applied commit records terminal failure");
	equal(inert.completions.length, 0, "inert cancellation emits no completion receipt");
	runDeferredMeasure(inertMeasure.request(), inert.view);
	const inertFinal = await Promise.race([
		probeAcceptance(inertAcceptance),
		new Promise<AcceptanceProbe>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 0)),
	]);
	equal(inertFinal.kind, "rejected", "late inert-view measure cannot revive acceptance");
	equal(inert.completions.length, 0, "late inert-view measure emits no receipt");
	inertMeasure.restore();
	destroy(inert);
}

console.log("\n--- Browser Test 8d: cache rollback never overwrites a superseding target ---");
{
	const item = fixture("source A");
	item.beginHandoff("B.md");
	const held = holdClearHostLoad(item, "host-cache-superseded", "B bytes");
	item.setRouteHooks({
		before: () => {
			item.selectHandoff("C.md");
			item.host.data = "C bytes";
			throw new Error("superseded-before-update");
		},
	});
	const result = await item.guard?.acceptHeldHostLoad({
		candidate: held.candidate as never,
		presentationPlanId: "cache-superseded-plan",
	});
	equal(result?.kind, "rejected", "B commit rejects after synchronous C supersession");
	equal(item.host.data, "C bytes", "B rollback never overwrites the superseding C runtime cache");
	equal(item.view.state.doc.toString(), "source A", "supersession before update leaves editor bytes unchanged");
	equal(item.guard?.snapshot().commitState, "failed", "target supersession makes the B commit terminal");
	equal(item.completions.length, 0, "superseded B emits no completion receipt");
	destroy(item);
}

console.log("\n--- Browser Test 8e: exact host-owned setState is held and committed once ---");
{
	const unproven = fixture("source A");
	unproven.beginHandoff("B.md");
	const unprovenState = EditorState.create({
		doc: "unproven B",
		extensions: unproven.extensions,
	});
	unproven.host.data = "unproven B";
	unproven.view.setState(unprovenState);
	equal(unproven.view.state.doc.toString(), "source A", "unarmed setState cannot bypass the handoff gate");
	equal(unproven.candidates.length, 0, "unarmed setState produces no host-load candidate");
	unproven.host.data = "source A";
	destroy(unproven);

	const exact = fixture("source A");
	exact.view.dispatch({
		changes: { from: exact.view.state.doc.length, insert: "!" },
		userEvent: "input.type",
	});
	exact.host.data = "source A!";
	assert(undoDepth(exact.view.state) > 0, "source state owns native undo history before handoff");
	exact.beginHandoff("B.md");
	const context = exact.currentHandoff();
	assert(exact.guard?.armHostLoad({
		hostLoadTokenId: "host-exact-set-state",
		...context,
		incomingContent: "certified B",
	}) === true, "exact state-replacement case arms the current host load");
	const targetState = EditorState.create({
		doc: "certified B",
		selection: EditorSelection.cursor(4),
		extensions: exact.extensions,
	});
	equal(undoDepth(targetState), 0, "host-owned target state starts without source undo history");
	exact.host.data = "certified B";
	exact.withExactHostStateReplacement(() => exact.view.setState(targetState));
	equal(exact.view.state.doc.toString(), "source A!", "exact host setState is held before controller admission");
	equal(exact.host.data, "source A!", "hold restores the source runtime cache by exact CAS");
	equal(exact.candidates.length, 1, "exact host setState emits one held candidate");
	const candidate = exact.candidates[0] as {
		applicationKind?: string;
		heldState?: EditorState | null;
		heldTransaction?: Transaction | null;
		targetDocument?: EditorState["doc"];
	} | undefined;
	equal(candidate?.applicationKind, "state", "candidate records the state-replacement application kind");
	equal(candidate?.heldState, targetState, "candidate retains the exact host-owned EditorState object");
	equal(candidate?.heldTransaction, null, "state replacement fabricates no substitute Transaction");
	equal(candidate?.targetDocument, targetState.doc, "candidate retains the exact target document identity");
	const accepted = await exact.guard?.acceptHeldHostLoad({
		candidate: candidate as never,
		presentationPlanId: "exact-set-state-plan",
	});
	equal(accepted?.kind, "accepted", "controller permit commits the exact held state once");
	equal(exact.view.state.doc.toString(), "certified B", "accepted state replacement presents target bytes");
	equal(exact.view.state.selection.main.head, 4, "accepted state replacement preserves target selection");
	equal(undoDepth(exact.view.state), 0, "accepted target state cannot undo into source history");
	equal(exact.view.state.readOnly, false, "accepted target stays writable while the logical handoff gate is closed");
	equal(exact.view.state.facet(handoffGateClosedFacet), true, "the logical handoff gate is closed again in the same turn");
	assert(handoffGateCompartment.get(exact.view.state) !== undefined, "accepted target state regains the managed gate compartment");
	equal(exact.host.data, "certified B", "accepted state replacement publishes target runtime cache bytes");
	equal(exact.completions.length, 1, "state replacement emits exactly one completion receipt");
	equal((await exact.guard?.acceptHeldHostLoad({
		candidate: candidate as never,
		presentationPlanId: "exact-set-state-plan",
	}))?.kind, "rejected", "the exact host state cannot be committed twice");
	equal(exact.completions.length, 1, "duplicate acceptance cannot duplicate the receipt");
	destroy(exact);
}

console.log("\n--- Browser Test 8e-recovery: exact setState survives an installed Recovery panel ---");
{
	const item = fixture("source A");
	item.beginHandoff("B.md");
	item.setRecoveryGateModel({
		state: "failed",
		message: "Interrupted input still needs a recovery choice.",
		actions: handoffRecoveryGateActions("failed"),
	});
	equal(item.guard?.refreshGate(), true, "failed Recovery panel installs before the host state replacement");
	assert(
		item.parent.querySelector(".kaos-handoff-recovery-gate") !== null,
		"state-replacement fixture owns a live Recovery panel",
	);
	const context = item.currentHandoff();
	assert(item.guard?.armHostLoad({
		hostLoadTokenId: "host-recovery-set-state",
		...context,
		incomingContent: "certified B",
	}) === true, "Recovery state-replacement case arms the current host load");
	const targetState = EditorState.create({
		doc: "certified B",
		selection: EditorSelection.cursor(4),
		extensions: item.extensions,
	});
	item.host.data = "certified B";
	item.withExactHostStateReplacement(() => item.view.setState(targetState));
	const candidate = item.candidates[0];
	assert(candidate !== undefined, "Recovery state replacement retains one exact candidate");
	const accepted = await item.guard?.acceptHeldHostLoad({
		candidate: candidate as never,
		presentationPlanId: "recovery-set-state-plan",
	});
	equal(accepted?.kind, "accepted", "Recovery panel DOM retirement cannot invalidate the exact host state");
	equal(item.view.state.doc.toString(), "certified B", "accepted Recovery state replacement presents B");
	equal(item.guard?.snapshot().commitState, "committed", "Recovery state replacement reaches committed state");
	equal(item.completions.length, 1, "Recovery state replacement emits one completion receipt");
	destroy(item);
}

console.log("\n--- Browser Test 8f: applied setState failure stays gated without inverse rollback ---");
{
	const item = fixture("source A");
	item.beginHandoff("B.md");
	const context = item.currentHandoff();
	assert(item.guard?.armHostLoad({
		hostLoadTokenId: "host-set-state-postcondition-failure",
		...context,
		incomingContent: "certified B",
	}) === true, "postcondition failure case arms the exact host state");
	const supersedingFile = file("C.md");
	const driftOnInstall = ViewPlugin.define(() => {
		item.host.file = supersedingFile;
		return {};
	});
	const targetState = EditorState.create({
		doc: "certified B",
		extensions: [
			...item.extensions,
			handoffGateCompartment.of(handoffGateClosedFacet.of(true)),
			driftOnInstall,
		],
	});
	item.host.data = "certified B";
	item.withExactHostStateReplacement(() => item.view.setState(targetState));
	const candidate = item.candidates[0];
	assert(candidate !== undefined, "postcondition failure retains an exact candidate before permit");
	const result = await item.guard?.acceptHeldHostLoad({
		candidate: candidate as never,
		presentationPlanId: "set-state-postcondition-failure-plan",
	});
	equal(result?.kind, "rejected", "target drift after exact setState rejects settlement");
	equal(item.view.state.doc.toString(), "certified B", "applied host state is never inverse-rolled back to source bytes");
	equal(item.view.state.readOnly, false, "failed applied state adds no read-only usage restriction");
	equal(item.view.state.facet(handoffGateClosedFacet), true, "failed applied state retains the logical gate marker");
	equal(item.guard?.snapshot().gateClosed, true, "failed applied state remains under the managed gate");
	equal(item.guard?.snapshot().commitState, "failed", "post-application failure is terminal for that token");
	equal(item.completions.length, 0, "failed applied state emits no completion receipt");
	destroy(item);
}

console.log("\n--- Browser Test 9: B candidate is inert after B-to-C supersession ---");
{
	const item = fixture("source A");
	item.beginHandoff("B.md");
	const context = item.currentHandoff();
	assert(item.guard?.armHostLoad({
		hostLoadTokenId: "host-B-stale",
		...context,
		incomingContent: "B bytes",
	}) === true, "B load association arms while B is current");
	const staleB = item.view.state.update({ changes: { from: 0, to: item.view.state.doc.length, insert: "B bytes" }, filter: false });
	item.host.data = "B bytes";
	item.view.dispatch(staleB);
	const candidate = item.candidates[0];
	item.beginHandoff("C.md");
	const result = await item.guard?.acceptHeldHostLoad({ candidate: candidate as never, presentationPlanId: "stale-plan" });
	equal(result?.kind, "rejected", "B acceptance is rejected after C becomes current");
	equal(item.view.state.doc.toString(), "source A", "stale B bytes never apply to C");
	const currentC = item.currentHandoff();
	assert(item.guard?.armHostLoad({
		hostLoadTokenId: "host-C-current",
		...currentC,
		incomingContent: "C bytes",
	}) === true, "stale B candidate cannot block the current C load association");
	destroy(item);
}

console.log("\n--- Browser Test 9a: runtime host-file drift fails closed independently of reducer context ---");
{
	const revisionDrift = fixture("source A");
	revisionDrift.beginHandoff("B.md");
	const revisionContext = revisionDrift.currentHandoff();
	equal(revisionDrift.guard?.armHostLoad({
		hostLoadTokenId: "host-revision-drift-at-arm",
		...revisionContext,
		editorRevisionBefore: revisionContext.editorRevisionBefore + 1,
		incomingContent: "B bytes",
	}), false, "captured CM revision drift rejects load association");
	destroy(revisionDrift);

	const armDrift = fixture("source A");
	armDrift.beginHandoff("B.md");
	const staleContext = armDrift.currentHandoff();
	armDrift.host.file = file("C.md");
	equal(armDrift.guard?.armHostLoad({
		hostLoadTokenId: "host-drift-at-arm",
		...staleContext,
		incomingContent: "B bytes",
	}), false, "host file drift rejects load association even when reducer context still says B");
	destroy(armDrift);

	const acceptDrift = fixture("source A");
	acceptDrift.beginHandoff("B.md");
	const context = acceptDrift.currentHandoff();
	assert(acceptDrift.guard?.armHostLoad({
		hostLoadTokenId: "host-drift-at-accept",
		...context,
		incomingContent: "B bytes",
	}) === true, "accept-drift case arms while exact host file is current");
	const transaction = acceptDrift.view.state.update({
		changes: { from: 0, to: acceptDrift.view.state.doc.length, insert: "B bytes" },
		effects: acceptDrift.resetHistory.of(true),
		filter: false,
	});
	acceptDrift.host.data = "B bytes";
	acceptDrift.view.dispatch(transaction);
	const candidate = acceptDrift.candidates[0];
	acceptDrift.host.file = file("C.md");
	equal((await acceptDrift.guard?.acceptHeldHostLoad({
		candidate: candidate as never,
		presentationPlanId: "drifted-host-plan",
	}))?.kind, "rejected", "host file drift rejects held-load acceptance before update");
	equal(acceptDrift.view.state.doc.toString(), "source A", "drifted host receives no B editor mutation");
	destroy(acceptDrift);

	const samePathReplacement = fixture("source A");
	samePathReplacement.beginHandoff("B.md");
	const originalContext = samePathReplacement.currentHandoff();
	assert(samePathReplacement.guard?.armHostLoad({
		hostLoadTokenId: "host-same-path-replacement",
		...originalContext,
		incomingContent: "B bytes",
	}) === true, "same-path replacement case arms with the original TFile");
	const samePathTransaction = samePathReplacement.view.state.update({
		changes: { from: 0, to: samePathReplacement.view.state.doc.length, insert: "B bytes" },
		effects: samePathReplacement.resetHistory.of(true),
		filter: false,
	});
	samePathReplacement.host.data = "B bytes";
	samePathReplacement.view.dispatch(samePathTransaction);
	const samePathCandidate = samePathReplacement.candidates[0];
	const replacementFile = file("B.md");
	samePathReplacement.host.file = replacementFile;
	samePathReplacement.setContext({ ...originalContext, targetFile: replacementFile });
	equal((await samePathReplacement.guard?.acceptHeldHostLoad({
		candidate: samePathCandidate as never,
		presentationPlanId: "replacement-file-plan",
	}))?.kind, "rejected", "same-path replacement TFile cannot inherit the held candidate");
	equal(samePathReplacement.view.state.doc.toString(), "source A", "same-path replacement file sees no held bytes");
	destroy(samePathReplacement);
}

console.log("\n--- Browser Test 10: same-path user/provider traffic preserves Transaction identity ---");
{
	const item = fixture("same path");
	const provider = item.view.state.update({ changes: { from: 9, insert: " provider" }, annotations: Transaction.remote.of(true) });
	item.view.dispatch(provider);
	equal(item.routedTransactions[0], provider, "same-path provider Transaction is forwarded unchanged");
	const user = item.view.state.update({ changes: { from: item.view.state.doc.length, insert: " user" }, userEvent: "input.type" });
	item.view.dispatch(user);
	equal(item.routedTransactions[1], user, "same-path user Transaction is forwarded unchanged");
	equal(item.guard?.snapshot().nativeHistoryEpoch, 2, "each routed same-path document update advances one history epoch");
	equal(item.nativeHistoryAdvances.length, 2, "each stable document update publishes one post-update history receipt");
	equal(item.nativeHistoryAdvances[0]?.nativeHistoryEpochBefore, 0, "the first receipt retains its exact prior epoch");
	equal(item.nativeHistoryAdvances[0]?.nativeHistoryEpochAfter, 1, "the first receipt advances exactly once");
	equal(item.nativeHistoryAdvances[1]?.nativeHistoryEpochBefore, 1, "the user receipt starts at the provider successor epoch");
	equal(item.nativeHistoryAdvances[1]?.nativeHistoryEpochAfter, 2, "the user receipt advances exactly once");
	equal(item.nativeHistoryAdvances[1]?.finalState, item.view.state, "the user receipt certifies the exact final EditorState");
	const replacement = EditorState.create({ doc: "same-path replacement", extensions: item.extensions });
	item.view.setState(replacement);
	equal(item.view.state.doc.toString(), "same-path replacement", "same-path setState remains available");
	equal(item.view.state.readOnly, false, "same-path setState reinstalls an open gate");
	assert(handoffGateCompartment.get(item.view.state) !== undefined, "same-path setState retains future handoff enforcement");
	equal(item.nativeHistoryAdvances.length, 3, "stable setState publishes one history receipt");
	equal(item.nativeHistoryAdvances[2]?.nativeHistoryEpochBefore, 2, "setState receipt retains its prior epoch");
	equal(item.nativeHistoryAdvances[2]?.nativeHistoryEpochAfter, 3, "setState receipt advances exactly once");
	equal(item.nativeHistoryAdvances[2]?.finalState, item.view.state, "setState receipt certifies the installed state");
	destroy(item);
}

console.log("\n--- Browser Test 10a: teardown retries without removing a still-closed safety boundary ---");
{
	const mark = fixture("source A");
	mark.beginHandoff();
	mark.setIntentDelivery("reject");
	const markLine = mark.view.contentDOM.querySelector<HTMLElement>(".cm-line");
	assert(markLine !== null, "markInert retry case has a mounted CodeMirror line");
	markLine.textContent = "unobserved pending bytes";
	equal(mark.guard?.markInert(), false, "markInert exposes pending-input release failure");
	equal(mark.guard?.snapshot().inert, false, "failed markInert leaves the guard live");
	equal(mark.guard?.snapshot().gateClosed, true, "failed markInert leaves the logical gate closed");
	mark.view.dispatch({ changes: { from: 0, to: mark.view.state.doc.length, insert: "stale mutation" }, filter: false });
	equal(mark.view.state.doc.toString(), "source A", "failed markInert keeps dispatch wrappers enforcing the gate");
	mark.setIntentDelivery("acknowledge");
	equal(mark.guard?.markInert(), true, "markInert succeeds when pending DOM state becomes exactly flushable");
	equal(mark.intents.length, 1, "retry acknowledges the exact DOM input intent before teardown");
	equal(mark.guard?.snapshot().inert, true, "successful retry enters inert state");
	equal(mark.guard?.restoreIfCurrent(), true, "an inert current guard can restore its exact wrappers");
	mark.view.dispatch({ changes: { from: mark.view.state.doc.length, insert: " restored" }, filter: false });
	equal(mark.view.state.doc.toString(), "source A restored", "restored dispatch route is usable after safe teardown");
	destroy(mark);

	const restore = fixture("source A");
	restore.beginHandoff();
	restore.setIntentDelivery("reject");
	const restoreLine = restore.view.contentDOM.querySelector<HTMLElement>(".cm-line");
	assert(restoreLine !== null, "restore retry case has a mounted CodeMirror line");
	restoreLine.textContent = "another unobserved mutation";
	equal(restore.guard?.restoreIfCurrent(), false, "restore refuses to remove wrappers when gate release is unproven");
	restore.view.dispatch({ changes: { from: 0, to: restore.view.state.doc.length, insert: "stale replacement" }, filter: false });
	equal(restore.view.state.doc.toString(), "source A", "failed restore keeps the final update boundary active");
	restore.setIntentDelivery("acknowledge");
	equal(restore.guard?.restoreIfCurrent(), true, "restore can be retried after pending DOM state is resolved");
	equal(restore.intents.length, 1, "restore retry acknowledges the exact DOM input intent before wrapper removal");
	destroy(restore);
}

console.log("\n--- Browser Test 10b: a safely restored EditorView accepts a fresh guard ---");
{
	const item = fixture("reused same path");
	equal(
		item.guard?.restoreIfCurrent(),
		true,
		"first guard safely restores its exact wrappers",
	);
	assert(
		handoffGateCompartment.get(item.view.state) !== undefined,
		"safe restore retains the reusable handoff gate compartment",
	);
	const reinstalled = installCodeMirrorHandoffGuard(item.view, {
		createId: (prefix) => `reinstalled:${prefix}:1`,
		getCurrentContext: () => ({
			kind: "same-path",
			sessionId: "session-reinstalled",
			leafId: "leaf-1",
			handoffGeneration: 0,
			path: "A.md",
		}),
		reserveManagedLeafInputStart: () => null,
		onHostLoadCandidate: () => true,
		onHostLoadCompleted: () => true,
		isExactHostStateReplacement: () => false,
		onInputIntent: () => true,
		isNativeHistoryReset: () => false,
		observeNativeHistoryReset: () => false,
		hashContent: (content) => content,
	});
	assert(reinstalled.kind === "installed", "second guard reuses the existing compartment");
	if (reinstalled.kind === "installed") {
		equal(reinstalled.guard.snapshot().gateClosed, false, "reinstalled same-path gate is open");
		item.view.dispatch({
			changes: { from: item.view.state.doc.length, insert: " after reinstall" },
			userEvent: "input.type",
		});
		equal(
			item.view.state.doc.toString(),
			"reused same path after reinstall",
			"reinstalled guard forwards ordinary same-path input",
		);
		equal(reinstalled.guard.restoreIfCurrent(), true, "second guard also restores safely");
	}
	item.view.destroy();
	item.parent.remove();
}

console.log("\n--- Browser Test 10c: Recovery controls stay content-free and operable ---");
{
	equal(
		handoffRecoveryGateActions("failed").join(","),
		"retry,copy-and-continue,export-and-continue,discard-and-continue",
		"failed Recovery exposes Retry plus three explicit escapes",
	);
	equal(
		handoffRecoveryGateActions("persisting").join(","),
		"copy-and-continue,export-and-continue,discard-and-continue",
		"a pending store remains escapable without pretending it failed",
	);
	equal(
		handoffRecoveryGateActions("escape-pending").join(","),
		"copy-and-continue,export-and-continue,discard-and-continue",
		"a pending escape remains visible and replaceable if its effect never settles",
	);
	equal(
		handoffRecoveryGateActions("replayed-awaiting-settlement").join(","),
		"retry-settlement,continue-without-automatic-apply",
		"indefinite settlement wait retains two non-dispatch choices",
	);

	const item = fixture("private source body");
	item.setRecoveryGateModel({
		state: "failed",
		message: "Interrupted input still needs a recovery choice.",
		actions: handoffRecoveryGateActions("failed"),
	});
	item.beginHandoff();
	assert(item.guard?.refreshGate() === true, "failed Recovery model refreshes the existing gate");
	const panel = item.parent.querySelector<HTMLElement>(".kaos-handoff-recovery-gate");
	assert(panel !== null, "failed Recovery renders one visible gate panel");
	assert(!panel.textContent?.includes("private source body"), "Recovery panel contains no note body");
	const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>("button"));
	equal(
		buttons.map((button) => button.textContent).join(","),
		"Retry,Copy and continue,Export and continue,Discard and continue",
		"failed gate uses the exact content-free action labels",
	);
	assert(buttons.every((button) => button.getAttribute("aria-label") === button.textContent), "every Recovery action has a content-free ARIA label");
	buttons[0]?.click();
	equal(item.recoveryGateActions.at(-1), "retry", "native Retry button invokes the exact callback");

	item.setRecoveryGateModel({
		state: "replayed-awaiting-settlement",
		message: "Automatic apply is waiting for settlement verification…",
		actions: handoffRecoveryGateActions("replayed-awaiting-settlement"),
	});
	assert(item.guard?.refreshGate() === true, "settlement model refreshes without releasing the logical gate");
	const settlementButtons = Array.from(
		item.parent.querySelectorAll<HTMLButtonElement>(".kaos-handoff-recovery-gate button"),
	);
	equal(
		settlementButtons.map((button) => button.textContent).join(","),
		"Retry settlement,Continue without automatic apply",
		"settlement wait always has an observable non-redispatch escape",
	);
	settlementButtons[1]?.click();
	equal(
		item.recoveryGateActions.at(-1),
		"continue-without-automatic-apply",
		"manual continuation callback is wired",
	);
	destroy(item);
}

console.log("\n--- Browser Test 11: restore, idempotence, cross-instance, and capability closure ---");
{
	const idlessParent = document.createElement("div");
	document.body.appendChild(idlessParent);
	const idlessView = new EditorView({ parent: idlessParent, doc: "closed" });
	const idless = installCodeMirrorHandoffGuard(idlessView, {
		getCurrentContext: () => null,
		reserveManagedLeafInputStart: () => null,
		onHostLoadCandidate: () => true,
		onHostLoadCompleted: () => true,
		isExactHostStateReplacement: () => false,
		onInputIntent: () => true,
		isNativeHistoryReset: () => false,
		observeNativeHistoryReset: () => false,
		hashContent: (content) => content,
	} as never);
	assert(
		idless.kind === "unsupported" && idless.reason === "id-factory-unavailable",
		"a guard without a boot-scoped ID factory fails closed before installation",
	);
	idlessView.destroy();
	idlessParent.remove();

	const first = fixture();
	const secondInstall = installCodeMirrorHandoffGuard(first.view, {
		createId: (prefix) => `idempotent:${prefix}:1`,
		getCurrentContext: () => null,
		reserveManagedLeafInputStart: () => null,
		onHostLoadCandidate: () => true,
		onHostLoadCompleted: () => true,
		isExactHostStateReplacement: () => false,
		onInputIntent: () => true,
		isNativeHistoryReset: () => false,
		observeNativeHistoryReset: () => false,
		hashContent: (content) => content,
	});
	assert(secondInstall.kind === "installed" && secondInstall.guard === first.guard, "installation is idempotent per exact view");
	const second = fixture("other view");
	first.guard?.markInert();
	const firstBefore = first.view.state.doc.toString();
	first.view.dispatch({ changes: { from: firstBefore.length, insert: " inert" } });
	equal(first.view.state.doc.toString(), `${firstBefore} inert`, "inert wrapper delegates without live guard state");
	equal(second.view.state.doc.toString(), "other view", "one guard cannot mutate another EditorView");
	first.guard?.restoreIfCurrent();
	const restoredBefore = first.view.state.doc.toString();
	first.view.dispatch({ changes: { from: restoredBefore.length, insert: " restored" } });
	equal(first.view.state.doc.toString(), `${restoredBefore} restored`, "restore removes only current wrappers");
	destroy(first);
	destroy(second);

	const unsupportedParent = document.createElement("div");
	document.body.appendChild(unsupportedParent);
	const unsupportedView = new EditorView({ parent: unsupportedParent, doc: "closed" });
	const originalUpdate = unsupportedView.update;
	Object.defineProperty(unsupportedView, "dispatch", {
		configurable: false,
		writable: false,
		value: unsupportedView.dispatch,
	});
	const unsupported = installCodeMirrorHandoffGuard(unsupportedView, {
		createId: (prefix) => `unsupported:${prefix}:1`,
		getCurrentContext: () => null,
		reserveManagedLeafInputStart: () => null,
		onHostLoadCandidate: () => true,
		onHostLoadCompleted: () => true,
		isExactHostStateReplacement: () => false,
		onInputIntent: () => true,
		isNativeHistoryReset: () => false,
		observeNativeHistoryReset: () => false,
		hashContent: (content) => content,
	});
	assert(unsupported.kind === "unsupported" && unsupported.reason === "dispatch-not-wrappable", "non-wrappable dispatch is explicitly unsupported");
	equal(unsupportedView.update, originalUpdate, "failed preflight installs no partial update wrapper");
	unsupportedView.destroy();
	unsupportedParent.remove();

	const unsupportedCases = [
		{
			name: "destroy lifecycle",
			reason: "destroy-not-wrappable",
			breakView(target: EditorView): void {
				Object.defineProperty(target, "destroy", { configurable: false, writable: false, value: target.destroy.bind(target) });
			},
		},
		{
			name: "update",
			reason: "update-not-wrappable",
			breakView(target: EditorView): void {
				Object.defineProperty(target, "update", { configurable: false, writable: false, value: target.update });
			},
		},
		{
			name: "setState",
			reason: "set-state-not-wrappable",
			breakView(target: EditorView): void {
				Object.defineProperty(target, "setState", { configurable: false, writable: false, value: target.setState });
			},
		},
		{
			name: "final route",
			reason: "final-boundary-not-provable",
			breakView(target: EditorView): void {
				Object.defineProperty(target, "dispatchTransactions", { configurable: true, writable: true, value: null });
			},
		},
		{
			name: "pending DOM observer",
			reason: "pending-dom-input-not-capturable",
			breakView(target: EditorView): void {
				(target as unknown as { observer: { forceFlush: unknown } }).observer.forceFlush = null;
			},
		},
	] as const;
	for (const unsupportedCase of unsupportedCases) {
		const targetParent = document.createElement("div");
		document.body.appendChild(targetParent);
		const target = new EditorView({ parent: targetParent, doc: "closed" });
		unsupportedCase.breakView(target);
		const result = installCodeMirrorHandoffGuard(target, {
			createId: (prefix) => `${unsupportedCase.name}:${prefix}:1`,
			getCurrentContext: () => null,
			reserveManagedLeafInputStart: () => null,
				onHostLoadCandidate: () => true,
				onHostLoadCompleted: () => true,
				isExactHostStateReplacement: () => false,
				onInputIntent: () => true,
			isNativeHistoryReset: () => false,
			observeNativeHistoryReset: () => false,
			hashContent: (content) => content,
		});
		assert(
			result.kind === "unsupported" && (result.reason as string) === unsupportedCase.reason,
			`${unsupportedCase.name} capability fails closed with its explicit reason`,
		);
		target.destroy();
		targetParent.remove();
	}
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
