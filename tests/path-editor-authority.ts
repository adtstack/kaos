import assert from "node:assert/strict";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MarkdownView, TFile } from "obsidian";
import type * as Y from "yjs";
import {
	createManagedLeafSession,
	reduceManagedLeafSession,
	type ManagedLeafSession,
} from "../src/sync/editorHandoffState";
import {
	createPathEditorAuthorityPort,
	type EditorAuthorityLease,
	type PathEditorAuthorityManagedPane,
	type PathEditorAuthoritySource,
} from "../src/sync/pathEditorAuthority";

type MutableView = MarkdownView & { file: TFile | null };
type MutableCm = EditorView & { state: { doc: Text } };

type PaneFixture = {
	file: TFile;
	view: MutableView;
	document: Text;
	cm: MutableCm;
	ytext: Y.Text;
	pane: PathEditorAuthorityManagedPane;
};

type MutableSource = PathEditorAuthoritySource & {
	panes: PathEditorAuthorityManagedPane[];
	openViewsByPath: Map<string, unknown[]>;
	captureManagedCalls: number;
	captureOpenCalls: number;
	authorityEpoch: number;
	epochReadCalls: number;
	throwEpochOnRead: number | null;
	nonceCalls: number;
	forbiddenMutationCalls: number;
	throwManagedCapture: boolean;
	throwOpenCapture: boolean;
	throwNonce: boolean;
};

function fakeFile(path: string, identity = path): TFile {
	return { path, identity } as unknown as TFile;
}

function fakeText(value: string): Text {
	return {
		length: value.length,
		toString: () => value,
	} as unknown as Text;
}

function fakeCm(document: Text, identity: string): MutableCm {
	return {
		identity,
		state: { doc: document },
	} as unknown as MutableCm;
}

function fakeYText(identity: string): Y.Text {
	return { identity } as unknown as Y.Text;
}

function createPane(input?: Readonly<{
	path?: string;
	fileId?: string;
	content?: string;
	leafId?: string;
	sessionId?: string;
	bindingEpoch?: number;
	editorRevision?: number;
	bound?: boolean;
	file?: TFile;
}>): PaneFixture {
	const path = input?.path ?? "B.md";
	const fileId = input?.fileId ?? "file-b";
	const content = input?.content ?? "content:B";
	const file = input?.file ?? fakeFile(path);
	const view = { file } as unknown as MutableView;
	const document = fakeText(content);
	const cm = fakeCm(document, `cm:${input?.leafId ?? "leaf-b"}`);
	const ytext = fakeYText(`ytext:${input?.leafId ?? "leaf-b"}`);
	const editorRevision = input?.editorRevision ?? 7;
	const session = createManagedLeafSession({
		sessionId: input?.sessionId ?? `session:${input?.leafId ?? "leaf-b"}`,
		leafId: input?.leafId ?? "leaf-b",
		view,
		displayedLineage: {
			kind: "known",
			file,
			path,
			fileId,
			cm,
			document,
			editorRevision,
		},
		binding: input?.bound === false
			? { kind: "unbound" }
			: { kind: "bound", path, fileId, ytext },
	});
	return {
		file,
		view,
		document,
		cm,
		ytext,
		pane: {
			session,
			currentCm: cm,
			bindingEpoch: input?.bindingEpoch ?? 11,
			editorRevision,
			read: { kind: "ok", content },
		},
	};
}

function createSource(input?: Readonly<{
	panes?: readonly PathEditorAuthorityManagedPane[];
	openViews?: Readonly<Record<string, readonly unknown[]>>;
	nonce?: string;
	authorityEpoch?: number;
}>): MutableSource {
	let nonceCounter = 0;
	const source: MutableSource = {
		panes: [...(input?.panes ?? [])],
		openViewsByPath: new Map(
			Object.entries(input?.openViews ?? {}).map(([path, views]) => [path, [...views]]),
		),
		captureManagedCalls: 0,
		captureOpenCalls: 0,
		authorityEpoch: input?.authorityEpoch ?? 0,
		epochReadCalls: 0,
		throwEpochOnRead: null,
		nonceCalls: 0,
		forbiddenMutationCalls: 0,
		throwManagedCapture: false,
		throwOpenCapture: false,
		throwNonce: false,
		captureManagedPanes() {
			this.captureManagedCalls += 1;
			if (this.throwManagedCapture) throw new Error("managed capture failed");
			return this.panes;
		},
		captureOpenFileViews(path) {
			this.captureOpenCalls += 1;
			if (this.throwOpenCapture) throw new Error("open-view capture failed");
			return this.openViewsByPath.get(path) ?? [];
		},
		readAuthorityEpoch() {
			this.epochReadCalls += 1;
			if (this.throwEpochOnRead === this.epochReadCalls) {
				throw new Error("authority epoch read failed");
			}
			return this.authorityEpoch;
		},
		createLeaseNonce() {
			if (this.throwNonce) throw new Error("nonce failed");
			this.nonceCalls += 1;
			nonceCounter += 1;
			return input?.nonce ?? `test-nonce:${nonceCounter}`;
		},
	};
	return source;
}

function sourceFor(...fixtures: readonly PaneFixture[]): MutableSource {
	const openViews: Record<string, unknown[]> = {};
	for (const fixture of fixtures) {
		const path = fixture.view.file?.path;
		if (path === undefined) continue;
		(openViews[path] ??= []).push(fixture.view);
	}
	return createSource({
		panes: fixtures.map((fixture) => fixture.pane),
		openViews,
	});
}

function requireProven(
	authority: ReturnType<ReturnType<typeof createPathEditorAuthorityPort>["capturePathEditorAuthority"]>,
): Extract<typeof authority, { kind: "proven-single" }> {
	assert.equal(authority.kind, "proven-single");
	if (authority.kind !== "proven-single") throw new Error("Expected proven-single authority");
	return authority;
}

function replacePane(
	source: MutableSource,
	index: number,
	update: (pane: PathEditorAuthorityManagedPane) => PathEditorAuthorityManagedPane,
): void {
	const pane = source.panes[index];
	if (pane === undefined) throw new Error(`Missing pane ${index}`);
	source.panes[index] = update(pane);
}

function withSession(
	pane: PathEditorAuthorityManagedPane,
	update: (session: ManagedLeafSession) => ManagedLeafSession,
): PathEditorAuthorityManagedPane {
	return { ...pane, session: update(pane.session) };
}

// No managed candidate and no matching open view is authoritative absence.
{
	const unrelated = createPane({ path: "A.md", fileId: "file-a", leafId: "leaf-a" });
	const source = sourceFor(unrelated);
	const port = createPathEditorAuthorityPort(source);
	assert.deepEqual(port.capturePathEditorAuthority("C.md"), { kind: "none" });
	assert.equal(source.captureManagedCalls, 1);
	assert.equal(source.captureOpenCalls, 1);
}

// One exact, fully healthy pane produces frozen nominal authority.
{
	const fixture = createPane();
	const source = sourceFor(fixture);
	const port = createPathEditorAuthorityPort(source);
	const proven = requireProven(port.capturePathEditorAuthority("B.md"));
	assert.equal(proven.content, "content:B");
	assert.equal(Object.isFrozen(proven.lease), true);
	assert.equal(port.isLeaseCurrent(proven.lease), true);
	const repeated = requireProven(port.capturePathEditorAuthority("B.md"));
	assert.equal(repeated.lease, proven.lease, "stable proof reuses its nominal lease");
	assert.equal(source.nonceCalls, 1, "stable recapture does not grow the lease registry");
}

// Equal panes collapse to one canonical composite proof independent of source order.
{
	const sharedFile = fakeFile("B.md", "shared-file-b");
	const first = createPane({ leafId: "leaf-z", sessionId: "session-z", file: sharedFile });
	const second = createPane({ leafId: "leaf-a", sessionId: "session-a", file: sharedFile });
	const source = sourceFor(first, second);
	const port = createPathEditorAuthorityPort(source);
	const proven = requireProven(port.capturePathEditorAuthority("B.md"));
	source.panes.reverse();
	source.openViewsByPath.get("B.md")?.reverse();
	assert.equal(port.isLeaseCurrent(proven.lease), true);
	assert.equal(proven.content, "content:B");
}

// Same path/fileId/content is still multiple authority when exact TFile differs.
{
	const first = createPane({ leafId: "leaf-a", file: fakeFile("B.md", "file-object-a") });
	const second = createPane({ leafId: "leaf-b", file: fakeFile("B.md", "file-object-b") });
	assert.deepEqual(
		createPathEditorAuthorityPort(sourceFor(first, second))
			.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "multiple" },
	);
}

// Each candidate-path source independently prevents false absence.
{
	const currentOnly = createPane({ path: "A.md", fileId: "file-a" });
	currentOnly.view.file = fakeFile("B.md");
	let source = createSource({
		panes: [currentOnly.pane],
		openViews: { "B.md": [currentOnly.view] },
	});
	assert.notEqual(
		createPathEditorAuthorityPort(source).capturePathEditorAuthority("B.md").kind,
		"none",
		"current view file",
	);

	const displayedOnly = createPane({ path: "B.md", bound: false });
	displayedOnly.view.file = fakeFile("A.md");
	source = createSource({ panes: [displayedOnly.pane] });
	assert.notEqual(
		createPathEditorAuthorityPort(source).capturePathEditorAuthority("B.md").kind,
		"none",
		"displayed lineage",
	);

	const bindingOnly = createPane({ path: "A.md", fileId: "file-a" });
	source = sourceFor(bindingOnly);
	replacePane(source, 0, (pane) => withSession(pane, (session) => ({
		...session,
		displayedLineage: { kind: "unknown" },
		binding: {
			kind: "bound",
			path: "B.md",
			fileId: "file-b",
			ytext: fakeYText("binding-only"),
		},
	})));
	assert.notEqual(
		createPathEditorAuthorityPort(source).capturePathEditorAuthority("B.md").kind,
		"none",
		"binding path",
	);

	for (const [label, sourceAuthorityPath, targetPath] of [
		["handoff source", "B.md", "D.md"],
		["handoff target", "D.md", "B.md"],
	] as const) {
		const handoffOnly = createPane({ path: "A.md", fileId: "file-a", bound: false });
		const handoffSource = sourceFor(handoffOnly);
		replacePane(handoffSource, 0, (pane) => withSession(pane, (session) => ({
			...session,
			displayedLineage: { kind: "unknown" },
			handoff: {
				sourceAuthorityPath,
				sourceUnloadReceiptId: "source-unload:path-authority:1",
				targetPath,
				targetFile: fakeFile(targetPath),
				bindingEpochAfterDetach: pane.bindingEpoch,
				presentation: "source",
				targetReadyTokenId: null,
				inputGateInstalled: true,
				saveGuardInstalled: true,
				recoveryOperationEpoch: 0,
				intentState: { kind: "none" },
				phase: "awaiting-host-load",
				pendingHostLoadCandidate: null,
			},
		})));
		assert.notEqual(
			createPathEditorAuthorityPort(handoffSource)
				.capturePathEditorAuthority("B.md").kind,
			"none",
			label,
		);
	}
}

// Content or fileId disagreement is multiple authority, not dirty target content.
{
	const first = createPane({ leafId: "leaf-a" });
	const differentContent = createPane({ leafId: "leaf-b", content: "different" });
	let port = createPathEditorAuthorityPort(sourceFor(first, differentContent));
	assert.deepEqual(port.capturePathEditorAuthority("B.md"), {
		kind: "blocked",
		reason: "multiple",
	});

	const differentId = createPane({ leafId: "leaf-c", fileId: "file-other" });
	port = createPathEditorAuthorityPort(sourceFor(first, differentId));
	assert.deepEqual(port.capturePathEditorAuthority("B.md"), {
		kind: "blocked",
		reason: "multiple",
	});
}

// Explicit read failure, unknown lineage, and unmanaged/opaque views fail closed.
{
	const unreadable = createPane();
	const unreadableSource = sourceFor(unreadable);
	replacePane(unreadableSource, 0, (pane) => ({ ...pane, read: { kind: "failed" } }));
	assert.deepEqual(
		createPathEditorAuthorityPort(unreadableSource).capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "read-failed" },
	);

	const unknown = createPane();
	const unknownSource = sourceFor(unknown);
	replacePane(unknownSource, 0, (pane) => withSession(pane, (session) => ({
		...session,
		displayedLineage: { kind: "unknown" },
	})));
	assert.deepEqual(
		createPathEditorAuthorityPort(unknownSource).capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
	);

	const managed = createPane();
	const opaqueView = { file: managed.file, opaque: true };
	const opaqueSource = sourceFor(managed);
	opaqueSource.openViewsByPath.set("B.md", [managed.view, opaqueView]);
	assert.deepEqual(
		createPathEditorAuthorityPort(opaqueSource).capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "unmanaged-view" },
	);

	const unmanagedOnly = createSource({ openViews: { "B.md": [opaqueView] } });
	assert.deepEqual(
		createPathEditorAuthorityPort(unmanagedOnly).capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "unmanaged-view" },
	);
}

// The complete candidate union includes current file, lineage, binding and both handoff paths.
{
	const fileA = fakeFile("A.md");
	const fixture = createPane({ path: "A.md", fileId: "file-a", file: fileA, leafId: "leaf-a" });
	const fileB = fakeFile("B.md");
	const transition = reduceManagedLeafSession(fixture.pane.session, {
		type: "target-selected",
		sessionId: fixture.pane.session.sessionId,
		expectedGeneration: fixture.pane.session.generation,
		targetFile: fileB,
		switchIntentSeq: 1,
		sourceUnloadReceiptId: "source-unload:test",
	});
	assert.equal(transition.accepted, true);
	fixture.view.file = fileB;
	const source = createSource({
		panes: [{ ...fixture.pane, session: transition.state }],
		openViews: { "B.md": [fixture.view] },
	});
	const port = createPathEditorAuthorityPort(source);
	assert.deepEqual(port.capturePathEditorAuthority("B.md"), {
		kind: "blocked",
		reason: "transitioning",
	});
	assert.notEqual(port.capturePathEditorAuthority("A.md").kind, "none");
	assert.deepEqual(port.capturePathEditorAuthority("C.md"), { kind: "none" });
}

// A fully target-proven displayed lineage may be unbound before final binding.
{
	const fixture = createPane({ bound: false });
	const source = sourceFor(fixture);
	const port = createPathEditorAuthorityPort(source);
	assert.equal(port.capturePathEditorAuthority("B.md").kind, "proven-single");

	const targetProven = createPane({ bound: false });
	const targetSource = sourceFor(targetProven);
	replacePane(targetSource, 0, (pane) => withSession(pane, (session) => ({
		...session,
		generation: 2,
		eventOrderSeq: 3,
		currentSwitchIntentSeq: 3,
		completedDetachEpoch: pane.bindingEpoch,
		handoff: {
			sourceAuthorityPath: "A.md",
			sourceUnloadReceiptId: "source-unload:path-authority:2",
			targetPath: "B.md",
			targetFile: targetProven.file,
			bindingEpochAfterDetach: pane.bindingEpoch,
			presentation: "target-proven",
			targetReadyTokenId: "target-ready:b",
			inputGateInstalled: false,
			saveGuardInstalled: false,
			recoveryOperationEpoch: 0,
			intentState: { kind: "none" },
			phase: "target-ready",
			pendingHostLoadCandidate: null,
		},
	})));
	assert.equal(
		createPathEditorAuthorityPort(targetSource)
			.capturePathEditorAuthority("B.md").kind,
		"proven-single",
		"real target-proven handoff remains usable before bind",
	);

	const mismatchedBinding = createPane();
	const mismatchSource = sourceFor(mismatchedBinding);
	replacePane(mismatchSource, 0, (pane) => withSession(pane, (session) => ({
		...session,
		binding: {
			kind: "bound",
			path: "other.md",
			fileId: "file-other",
			ytext: fakeYText("wrong"),
		},
	})));
	assert.deepEqual(
		createPathEditorAuthorityPort(mismatchSource).capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
	);
}

// Every exact proof component and complete pane/open-view vector participates in CAS.
{
	type Mutation = Readonly<{
		name: string;
		apply(source: MutableSource, fixture: PaneFixture): void;
	}>;
	const mutations: readonly Mutation[] = [
		{
			name: "current TFile identity",
			apply: (_source, fixture) => {
				fixture.view.file = fakeFile("B.md", "replacement-file");
			},
		},
		{
			name: "session generation",
			apply: (source) => replacePane(source, 0, (pane) => withSession(pane, (session) => ({
				...session,
				generation: session.generation + 1,
			}))),
		},
		{
			name: "session identity",
			apply: (source) => replacePane(source, 0, (pane) => withSession(pane, (session) => ({
				...session,
				sessionId: `${session.sessionId}:replacement`,
			}))),
		},
		{
			name: "CodeMirror identity",
			apply: (source, fixture) => {
				const nextCm = fakeCm(fixture.document, "cm:replacement");
				replacePane(source, 0, (pane) => withSession(
					{ ...pane, currentCm: nextCm },
					(session) => ({
						...session,
						displayedLineage: session.displayedLineage.kind === "known"
							? { ...session.displayedLineage, cm: nextCm }
							: session.displayedLineage,
					}),
				));
			},
		},
		{
			name: "CodeMirror document identity",
			apply: (source, fixture) => {
				const nextDocument = fakeText("content:B");
				fixture.cm.state.doc = nextDocument;
				replacePane(source, 0, (pane) => withSession(pane, (session) => ({
					...session,
					displayedLineage: session.displayedLineage.kind === "known"
						? { ...session.displayedLineage, document: nextDocument }
						: session.displayedLineage,
				})));
			},
		},
		{
			name: "editor revision",
			apply: (source) => replacePane(source, 0, (pane) => withSession(
				{ ...pane, editorRevision: pane.editorRevision + 1 },
				(session) => ({
					...session,
					displayedLineage: session.displayedLineage.kind === "known"
						? {
							...session.displayedLineage,
							editorRevision: session.displayedLineage.editorRevision + 1,
						}
						: session.displayedLineage,
				}),
			)),
		},
		{
			name: "binding epoch",
			apply: (source) => replacePane(source, 0, (pane) => ({
				...pane,
				bindingEpoch: pane.bindingEpoch + 1,
			})),
		},
		{
			name: "Y.Text identity",
			apply: (source) => replacePane(source, 0, (pane) => withSession(pane, (session) => ({
				...session,
				binding: session.binding.kind === "bound"
					? { ...session.binding, ytext: fakeYText("replacement-ytext") }
					: session.binding,
			}))),
		},
		{
			name: "binding record identity",
			apply: (source) => {
				const pane = source.panes[0];
				if (pane === undefined || pane.session.binding.kind !== "bound") {
					throw new Error("Missing bound pane");
				}
				const replacement = { ...pane.session.binding };
				(pane.session as unknown as { binding: ManagedLeafSession["binding"] }).binding = replacement;
			},
		},
		{
			name: "fileId",
			apply: (source) => replacePane(source, 0, (pane) => withSession(pane, (session) => ({
				...session,
				displayedLineage: session.displayedLineage.kind === "known"
					? { ...session.displayedLineage, fileId: "file-replacement" }
					: session.displayedLineage,
				binding: session.binding.kind === "bound"
					? { ...session.binding, fileId: "file-replacement" }
					: session.binding,
			}))),
		},
		{
			name: "content",
			apply: (source, fixture) => {
				const nextDocument = fakeText("changed");
				fixture.cm.state.doc = nextDocument;
				replacePane(source, 0, (pane) => withSession(
					{ ...pane, read: { kind: "ok", content: "changed" } },
					(session) => ({
						...session,
						displayedLineage: session.displayedLineage.kind === "known"
							? { ...session.displayedLineage, document: nextDocument }
							: session.displayedLineage,
					}),
				));
			},
		},
		{
			name: "handoff lineage",
			apply: (source, fixture) => replacePane(source, 0, (pane) => withSession(pane, (session) => ({
				...session,
				handoff: {
					sourceAuthorityPath: "B.md",
					sourceUnloadReceiptId: "source-unload:path-authority:3",
					targetPath: "C.md",
					targetFile: fakeFile("C.md"),
					bindingEpochAfterDetach: pane.bindingEpoch,
					presentation: "source",
					targetReadyTokenId: null,
					inputGateInstalled: true,
					saveGuardInstalled: true,
					recoveryOperationEpoch: 0,
					intentState: { kind: "none" },
					phase: "awaiting-host-load",
					pendingHostLoadCandidate: null,
				},
				view: fixture.view,
			}))),
		},
	];

	for (const mutation of mutations) {
		const fixture = createPane();
		const source = sourceFor(fixture);
		const port = createPathEditorAuthorityPort(source);
		const lease = requireProven(port.capturePathEditorAuthority("B.md")).lease;
		mutation.apply(source, fixture);
		assert.equal(port.isLeaseCurrent(lease), false, mutation.name);
	}

	const fixture = createPane();
	const source = sourceFor(fixture);
	const port = createPathEditorAuthorityPort(source);
	const lease = requireProven(port.capturePathEditorAuthority("B.md")).lease;
	source.panes.push(createPane({ path: "Z.md", fileId: "file-z", leafId: "leaf-z" }).pane);
	assert.equal(port.isLeaseCurrent(lease), false, "unrelated managed pane addition");

	const compositeFile = fakeFile("B.md", "composite-file-b");
	const compositeA = createPane({ leafId: "leaf-a", file: compositeFile });
	const compositeB = createPane({ leafId: "leaf-b", file: compositeFile });
	const compositeSource = sourceFor(compositeA, compositeB);
	const compositePort = createPathEditorAuthorityPort(compositeSource);
	const compositeLease = requireProven(
		compositePort.capturePathEditorAuthority("B.md"),
	).lease;
	compositeSource.panes.pop();
	compositeSource.openViewsByPath.set("B.md", [compositeA.view]);
	assert.equal(compositePort.isLeaseCurrent(compositeLease), false, "pane removal");

	const identityFile = fakeFile("B.md", "identity-shared");
	const identityA = createPane({ leafId: "leaf-identity-a", file: identityFile });
	const identityB = createPane({ leafId: "leaf-identity-b", file: identityFile });
	const identitySource = sourceFor(identityA, identityB);
	const identityPort = createPathEditorAuthorityPort(identitySource);
	const identityLease = requireProven(
		identityPort.capturePathEditorAuthority("B.md"),
	).lease;
	const replacementFile = fakeFile("B.md", "identity-replacement");
	identityB.view.file = replacementFile;
	replacePane(identitySource, 1, (pane) => withSession(pane, (session) => ({
		...session,
		displayedLineage: session.displayedLineage.kind === "known"
			? { ...session.displayedLineage, file: replacementFile }
			: session.displayedLineage,
	})));
	assert.equal(
		identityPort.isLeaseCurrent(identityLease),
		false,
		"healthy-looking exact TFile replacement stales composite lease",
	);

	const openFixture = createPane();
	const openSource = sourceFor(openFixture);
	const openPort = createPathEditorAuthorityPort(openSource);
	const openLease = requireProven(openPort.capturePathEditorAuthority("B.md")).lease;
	openSource.openViewsByPath.set("B.md", [openFixture.view, { opaque: true }]);
	assert.equal(openPort.isLeaseCurrent(openLease), false, "open-view vector mutation");
}

// Exact object identity and the port-private registry reject every synthetic handle.
{
	const fixtureA = createPane();
	const sourceA = createSource({
		panes: [fixtureA.pane],
		openViews: { "B.md": [fixtureA.view] },
		nonce: "colliding-test-nonce",
	});
	const portA = createPathEditorAuthorityPort(sourceA);
	const leaseA = requireProven(portA.capturePathEditorAuthority("B.md")).lease;
	assert.equal(portA.isLeaseCurrent({ leaseId: "made-up" } as EditorAuthorityLease), false);
	assert.equal(portA.isLeaseCurrent({ ...leaseA } as EditorAuthorityLease), false);

	const fixtureB = createPane();
	const sourceB = createSource({
		panes: [fixtureB.pane],
		openViews: { "B.md": [fixtureB.view] },
		nonce: "colliding-test-nonce",
	});
	const portB = createPathEditorAuthorityPort(sourceB);
	const leaseB = requireProven(portB.capturePathEditorAuthority("B.md")).lease;
	assert.equal(portA.isLeaseCurrent(leaseB), false, "cross-port handle");
	assert.equal(portB.isLeaseCurrent(leaseA), false, "reverse cross-port handle");
	assert.equal(portA.isLeaseCurrent(leaseA), true);
	assert.equal(portB.isLeaseCurrent(leaseB), true);
}

// Capturing a new healthy path retires stale historical-path entries without
// disturbing concurrently current paths; a fixed test nonce can be reused.
{
	const fixtureB = createPane();
	const source = createSource({
		panes: [fixtureB.pane],
		openViews: { "B.md": [fixtureB.view] },
		nonce: "reusable-test-nonce",
	});
	const port = createPathEditorAuthorityPort(source);
	const leaseB = requireProven(port.capturePathEditorAuthority("B.md")).lease;
	assert.equal(leaseB.leaseId, "reusable-test-nonce");

	const fixtureC = createPane({ path: "C.md", fileId: "file-c", content: "content:C" });
	source.panes = [fixtureC.pane];
	source.openViewsByPath = new Map([["C.md", [fixtureC.view]]]);
	const leaseC = requireProven(port.capturePathEditorAuthority("C.md")).lease;
	assert.equal(
		leaseC.leaseId,
		"reusable-test-nonce",
		"stale B registry entry is retired before C lease allocation",
	);
	assert.equal(port.isLeaseCurrent(leaseB), false);
	assert.equal(port.isLeaseCurrent(leaseC), true);
}

// Independent paths that remain proven concurrently retain both exact leases.
{
	const fixtureB = createPane({ path: "B.md", fileId: "file-b", leafId: "leaf-b" });
	const fixtureC = createPane({ path: "C.md", fileId: "file-c", content: "content:C", leafId: "leaf-c" });
	const source = sourceFor(fixtureB, fixtureC);
	const port = createPathEditorAuthorityPort(source);
	const leaseB = requireProven(port.capturePathEditorAuthority("B.md")).lease;
	const leaseC = requireProven(port.capturePathEditorAuthority("C.md")).lease;
	assert.equal(port.isLeaseCurrent(leaseB), true);
	assert.equal(port.isLeaseCurrent(leaseC), true);
	assert.equal(
		requireProven(port.capturePathEditorAuthority("B.md")).lease,
		leaseB,
		"concurrent B recapture reuses B lease",
	);
}

function mutateLivePaneAfterTakingSnapshot(
	source: MutableSource,
	triggerCaptureCall: number,
	replacement: PathEditorAuthorityManagedPane,
): void {
	source.captureManagedPanes = function () {
		this.captureManagedCalls += 1;
		const returnedSnapshot = [...this.panes];
		if (this.captureManagedCalls === triggerCaptureCall) {
			this.panes = [replacement];
			this.authorityEpoch += 1;
		}
		return returnedSnapshot;
	};
}

// A source mutation after returning a self-consistent old vector is detected
// both at final lease publication and at the sole revalidation capture.
{
	const oldFixture = createPane();
	const newFixture = createPane({ content: "new-live-content" });
	const publicationSource = sourceFor(oldFixture);
	mutateLivePaneAfterTakingSnapshot(publicationSource, 2, newFixture.pane);
	assert.deepEqual(
		createPathEditorAuthorityPort(publicationSource)
			.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
		"final confirmation cannot publish an old snapshot after live mutation",
	);

	const revalidationOld = createPane();
	const revalidationNew = createPane({ content: "new-live-content" });
	const revalidationSource = sourceFor(revalidationOld);
	mutateLivePaneAfterTakingSnapshot(revalidationSource, 3, revalidationNew.pane);
	const revalidationPort = createPathEditorAuthorityPort(revalidationSource);
	const lease = requireProven(
		revalidationPort.capturePathEditorAuthority("B.md"),
	).lease;
	assert.equal(
		revalidationPort.isLeaseCurrent(lease),
		false,
		"revalidation cannot accept an old snapshot after live mutation",
	);
}

// Stability witness exceptions, drift, and observed ABA never expose a lease.
{
	const exceptionSource = sourceFor(createPane());
	exceptionSource.throwEpochOnRead = 2;
	const exceptionPort = createPathEditorAuthorityPort(exceptionSource);
	assert.deepEqual(
		exceptionPort.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
	);
	exceptionSource.throwEpochOnRead = null;
	assert.deepEqual(
		exceptionPort.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
		"a witness exception permanently poisons continuity",
	);

	const abaSource = sourceFor(createPane());
	const observedEpochs = [1, 2, 1, 1];
	abaSource.readAuthorityEpoch = function () {
		this.epochReadCalls += 1;
		const next = observedEpochs.shift();
		if (next === undefined) return 1;
		return next;
	};
	const abaPort = createPathEditorAuthorityPort(abaSource);
	assert.deepEqual(
		abaPort.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
		"witness drift blocks the first capture",
	);
	assert.deepEqual(
		abaPort.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
		"observed witness ABA/regression remains blocked",
	);

	const reusedMaximumSource = sourceFor(createPane());
	const reusedMaximumEpochs = [2, 1, 2, 2, 2, 2];
	reusedMaximumSource.readAuthorityEpoch = function () {
		this.epochReadCalls += 1;
		return reusedMaximumEpochs.shift() ?? 2;
	};
	const reusedMaximumPort = createPathEditorAuthorityPort(reusedMaximumSource);
	assert.deepEqual(
		reusedMaximumPort.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
		"2 to 1 regression poisons the first capture",
	);
	assert.deepEqual(
		reusedMaximumPort.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
		"reusing the prior maximum 2 cannot unpoison the port",
	);

	const invalidEpochSource = sourceFor(createPane());
	let invalidEpoch = Number.NaN;
	invalidEpochSource.readAuthorityEpoch = () => invalidEpoch;
	const invalidEpochPort = createPathEditorAuthorityPort(invalidEpochSource);
	assert.deepEqual(
		invalidEpochPort.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
	);
	invalidEpoch = 0;
	assert.deepEqual(
		invalidEpochPort.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
		"invalid epoch permanently poisons the port",
	);

	const monotonicAdvanceSource = sourceFor(createPane());
	const monotonicEpochs = [1, 2, 2, 2, 2, 2];
	monotonicAdvanceSource.readAuthorityEpoch = () => monotonicEpochs.shift() ?? 2;
	const monotonicAdvancePort = createPathEditorAuthorityPort(monotonicAdvanceSource);
	assert.deepEqual(
		monotonicAdvancePort.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
		"a monotonic advance during capture blocks only that unstable snapshot",
	);
	assert.equal(
		monotonicAdvancePort.capturePathEditorAuthority("B.md").kind,
		"proven-single",
		"a later stable snapshot at the advanced epoch remains usable",
	);
}

// Poison retires every concurrent lease, not only the lease whose check caught it.
{
	const fixtureB = createPane({ path: "B.md", fileId: "file-b", leafId: "leaf-b" });
	const fixtureC = createPane({ path: "C.md", fileId: "file-c", content: "content:C", leafId: "leaf-c" });
	const source = sourceFor(fixtureB, fixtureC);
	const port = createPathEditorAuthorityPort(source);
	const leaseB = requireProven(port.capturePathEditorAuthority("B.md")).lease;
	const leaseC = requireProven(port.capturePathEditorAuthority("C.md")).lease;
	const poisonEpochs = [2, 1, 2, 2];
	source.readAuthorityEpoch = () => poisonEpochs.shift() ?? 2;
	assert.equal(port.isLeaseCurrent(leaseB), false);
	assert.equal(port.isLeaseCurrent(leaseC), false);
	assert.deepEqual(
		port.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
	);
}

// Host arrays cannot silently omit conflicting entries through own methods or
// iterator overrides. Only indexed intrinsic copying may normalize them.
{
	const sharedFile = fakeFile("B.md", "hostile-vector-file");
	const healthy = createPane({ leafId: "leaf-a", file: sharedFile });
	const conflicting = createPane({
		leafId: "leaf-b",
		file: sharedFile,
		content: "conflicting-content",
	});
	const hostilePanes = [healthy.pane, conflicting.pane];
	Object.defineProperty(hostilePanes, "map", {
		configurable: true,
		value: () => [healthy.pane],
	});
	const hostileOpenViews = [healthy.view, conflicting.view];
	Object.defineProperty(hostileOpenViews, Symbol.iterator, {
		configurable: true,
		value: function* () {
			yield healthy.view;
		},
	});
	const source = createSource();
	source.panes = hostilePanes;
	source.openViewsByPath.set("B.md", hostileOpenViews);
	assert.deepEqual(
		createPathEditorAuthorityPort(source).capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "multiple" },
	);
}

// Capture/revalidation is pure and defensive: no activity transfer, no leaked lease.
{
	const fixture = createPane();
	const recentActivity = { value: "A.md" };
	const source = sourceFor(fixture) as MutableSource & {
		captureOpenEditorMutationTicket(): never;
		carryCmActivityToPath(): never;
	};
	source.captureOpenEditorMutationTicket = () => {
		source.forbiddenMutationCalls += 1;
		throw new Error("must stay pure");
	};
	source.carryCmActivityToPath = () => {
		source.forbiddenMutationCalls += 1;
		recentActivity.value = "B.md";
		throw new Error("must stay pure");
	};
	const port = createPathEditorAuthorityPort(source);
	const lease = requireProven(port.capturePathEditorAuthority("B.md")).lease;
	assert.equal(port.isLeaseCurrent(lease), true);
	assert.equal(source.forbiddenMutationCalls, 0);
	assert.equal(recentActivity.value, "A.md");

	source.throwManagedCapture = true;
	assert.deepEqual(port.capturePathEditorAuthority("B.md"), {
		kind: "blocked",
		reason: "transitioning",
	});
	assert.equal(port.isLeaseCurrent(lease), false, "capture failure stales existing lease");

	const openThrowSource = sourceFor(createPane());
	openThrowSource.throwOpenCapture = true;
	assert.deepEqual(
		createPathEditorAuthorityPort(openThrowSource).capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
	);

	const nonceThrowSource = sourceFor(createPane());
	nonceThrowSource.throwNonce = true;
	const nonceFailure = createPathEditorAuthorityPort(nonceThrowSource)
		.capturePathEditorAuthority("B.md");
	assert.deepEqual(nonceFailure, { kind: "blocked", reason: "transitioning" });

	const nonceMutationFixture = createPane();
	const nonceMutationSource = sourceFor(nonceMutationFixture);
	nonceMutationSource.createLeaseNonce = function () {
		this.panes = [];
		this.openViewsByPath.clear();
		return "mutating-nonce";
	};
	assert.deepEqual(
		createPathEditorAuthorityPort(nonceMutationSource)
			.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
		"nonce seam cannot publish proof made stale during lease creation",
	);

	const getterFixture = createPane();
	Object.defineProperty(getterFixture.view, "file", {
		configurable: true,
		get() {
			throw new Error("host getter failed");
		},
	});
	const getterSource = createSource({
		panes: [getterFixture.pane],
		openViews: { "B.md": [getterFixture.view] },
	});
	assert.deepEqual(
		createPathEditorAuthorityPort(getterSource).capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
	);

	const readGetterFixture = createPane();
	Object.defineProperty(readGetterFixture.pane, "read", {
		configurable: true,
		get() {
			throw new Error("editor read getter failed");
		},
	});
	assert.deepEqual(
		createPathEditorAuthorityPort(createSource({
			panes: [readGetterFixture.pane],
			openViews: { "B.md": [readGetterFixture.view] },
		})).capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
	);

	const openVectorFixture = createPane();
	const throwingOpenVector = new Proxy([openVectorFixture.view], {
		get(target, property, receiver) {
			if (property === "0") throw new Error("open vector getter failed");
			return Reflect.get(target, property, receiver);
		},
	});
	const openVectorSource = sourceFor(openVectorFixture);
	openVectorSource.captureOpenFileViews = () => throwingOpenVector;
	assert.deepEqual(
		createPathEditorAuthorityPort(openVectorSource)
			.capturePathEditorAuthority("B.md"),
		{ kind: "blocked", reason: "transitioning" },
	);
}

console.log("path editor authority tests passed");
