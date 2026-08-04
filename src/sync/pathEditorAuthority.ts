import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TFile } from "obsidian";
import type * as Y from "yjs";
import type { ManagedLeafSession } from "./editorHandoffState";

declare const editorAuthorityLeaseBrand: unique symbol;

export type EditorAuthorityLease = Readonly<{
	leaseId: string;
	readonly [editorAuthorityLeaseBrand]: true;
}>;

export type PathEditorAuthority =
	| Readonly<{ kind: "none" }>
	| Readonly<{
		kind: "proven-single";
		content: string;
		lease: EditorAuthorityLease;
	}>
	| Readonly<{
		kind: "blocked";
		reason: "transitioning" | "multiple" | "read-failed" | "unmanaged-view";
	}>;

export interface PathEditorAuthorityPort {
	capturePathEditorAuthority(path: string): PathEditorAuthority;
	isLeaseCurrent(lease: EditorAuthorityLease): boolean;
}

export type PathEditorAuthorityRead =
	| Readonly<{ kind: "ok"; content: string }>
	| Readonly<{ kind: "failed" }>;

/**
 * A side-effect-free, already managed pane observation. The manager supplies
 * its live counters explicitly so authority capture never has to transfer
 * CodeMirror activity or mint a mutation ticket.
 */
export type PathEditorAuthorityManagedPane = Readonly<{
	session: ManagedLeafSession;
	currentCm: EditorView | null;
	bindingEpoch: number;
	editorRevision: number;
	read: PathEditorAuthorityRead;
}>;

export interface PathEditorAuthoritySource {
	/**
	 * Pure-current stability witness for the two vector reads below. The source
	 * must synchronously advance this non-negative safe integer before publishing
	 * any authority-affecting pane, view, document, binding, read, or handoff
	 * change. It must never decrease, wrap, or reuse a prior value, and this read
	 * itself must not invoke callbacks or mutate source state. A thrown/invalid/
	 * regressed witness permanently poisons this port because continuity can no
	 * longer be proven; equal stable reads and monotonic advances remain valid.
	 */
	readAuthorityEpoch(): number;
	/** Captures every managed pane, not just panes believed to match a path. */
	captureManagedPanes(): readonly PathEditorAuthorityManagedPane[];
	/** Captures every host-visible file view currently reporting this path. */
	captureOpenFileViews(path: string): readonly unknown[];
	/** Test seam. Production callers omit it and use cryptographic randomness. */
	createLeaseNonce?(): string;
}

type CapturedBinding =
	| Readonly<{ kind: "unbound" }>
	| Readonly<{
		kind: "bound";
		path: string;
		fileId: string;
		ytext: Y.Text;
	}>;

type CapturedDisplayedLineage =
	| Readonly<{ kind: "unknown" }>
	| Readonly<{
		kind: "known";
		file: TFile;
		filePath: string;
		path: string;
		fileId: string | null;
		cm: EditorView;
		document: Text;
		editorRevision: number;
	}>;

type CapturedHandoff = null | Readonly<{
	ref: NonNullable<ManagedLeafSession["handoff"]>;
	sourceAuthorityPath: string | null;
	sourceUnloadReceiptId: string | null;
	targetPath: string;
	targetFile: TFile;
	targetFilePath: string;
	bindingEpochAfterDetach: number;
	presentation: "source" | "target-candidate";
	inputGateInstalled: boolean;
	saveGuardInstalled: boolean;
	pendingHostLoadCandidate: NonNullable<ManagedLeafSession["handoff"]>["pendingHostLoadCandidate"];
}>;

type CapturedPane = Readonly<{
	sortKey: string;
	session: ManagedLeafSession;
	sessionId: string;
	leafId: string;
	generation: number;
	eventOrderSeq: number;
	currentSwitchIntentSeq: number | null;
	nativeHistoryEpoch: number;
	completedDetachEpoch: number | null;
	completedSamePathInput: ManagedLeafSession["completedSamePathInput"];
	pendingInputStartReservation: ManagedLeafSession["pendingInputStartReservation"];
	view: ManagedLeafSession["view"];
	currentFile: TFile | null;
	currentFilePath: string | null;
	displayedLineageRef: ManagedLeafSession["displayedLineage"];
	displayedLineage: CapturedDisplayedLineage;
	displayedDocumentContent: string | null;
	bindingRef: ManagedLeafSession["binding"];
	binding: CapturedBinding;
	handoff: CapturedHandoff;
	currentCm: EditorView | null;
	currentDocument: Text | null;
	bindingEpoch: number;
	editorRevision: number;
	read: PathEditorAuthorityRead;
	contentHash: string | null;
	candidatePaths: readonly string[];
}>;

type AuthorityProof = Readonly<{
	requestedPath: string;
	authorityEpoch: number;
	fileId: string | null;
	content: string;
	contentHash: string;
	fingerprint: string;
	panes: readonly CapturedPane[];
	openViews: readonly unknown[];
}>;

type CapturedAuthority =
	| Readonly<{
		kind: "not-proven";
		authority: Exclude<PathEditorAuthority, { kind: "proven-single" }>;
	}>
	| Readonly<{
		kind: "proven";
		content: string;
		proof: AuthorityProof;
	}>;

type LeaseEntry = Readonly<{
	lease: EditorAuthorityLease;
	leaseId: string;
	proof: AuthorityProof;
}>;

type AuthorityEpochTracker = {
	highestObserved: number;
	poisoned: boolean;
};

const NONE: Extract<PathEditorAuthority, { kind: "none" }> = Object.freeze({ kind: "none" });

function blocked(
	reason: Extract<PathEditorAuthority, { kind: "blocked" }>["reason"],
): Extract<PathEditorAuthority, { kind: "blocked" }> {
	return Object.freeze({ kind: "blocked", reason });
}

function notProven(
	authority: Exclude<PathEditorAuthority, { kind: "proven-single" }>,
): CapturedAuthority {
	return { kind: "not-proven", authority };
}

function hashString(value: string): string {
	// The exact content is retained and compared as well. This deterministic hash
	// is a compact fingerprint component, not a substitute for byte equality.
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		first ^= code;
		first = Math.imul(first, 0x01000193);
		second ^= code + index;
		second = Math.imul(second, 0x85ebca6b);
	}
	return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function defaultLeaseNonce(): string {
	const cryptoProvider = globalThis.crypto;
	if (cryptoProvider === undefined || typeof cryptoProvider.getRandomValues !== "function") {
		throw new Error("Cryptographic randomness is unavailable");
	}
	const bytes = new Uint8Array(24);
	cryptoProvider.getRandomValues(bytes);
	let encoded = "";
	for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
	return encoded;
}

function uniqueSortedPaths(paths: readonly (string | null)[]): readonly string[] {
	const unique = new Set<string>();
	for (const path of paths) {
		if (path !== null) unique.add(path);
	}
	return [...unique].sort();
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
	return Array.isArray(value);
}

function copyHostArray(value: unknown): unknown[] {
	if (!isUnknownArray(value)) throw new Error("Authority source returned a non-array");
	const lengthBefore = value.length;
	if (!Number.isSafeInteger(lengthBefore) || lengthBefore < 0) {
		throw new Error("Authority source returned an invalid array length");
	}
	const copy = new Array<unknown>(lengthBefore);
	for (let index = 0; index < lengthBefore; index += 1) {
		// Deliberately use indexed access. Host arrays may override map, slice,
		// some, or Symbol.iterator to silently omit a conflicting pane/view.
		copy[index] = value[index];
	}
	if (value.length !== lengthBefore) {
		throw new Error("Authority source array changed while being copied");
	}
	return copy;
}

function readAuthorityEpoch(
	source: PathEditorAuthoritySource,
	tracker: AuthorityEpochTracker,
): number {
	if (tracker.poisoned) {
		throw new Error("Editor-authority epoch witness is poisoned");
	}
	let epoch: number;
	try {
		epoch = source.readAuthorityEpoch();
	} catch (error) {
		tracker.poisoned = true;
		throw error;
	}
	if (!Number.isSafeInteger(epoch) || epoch < 0) {
		tracker.poisoned = true;
		throw new Error("Invalid editor-authority epoch");
	}
	if (epoch < tracker.highestObserved) {
		tracker.poisoned = true;
		throw new Error("Editor-authority epoch regressed or was reused");
	}
	tracker.highestObserved = epoch;
	return epoch;
}

function capturePane(pane: PathEditorAuthorityManagedPane): CapturedPane {
	const session = pane.session;
	const view = session.view;
	const currentFile = view.file;
	const currentFilePath = currentFile?.path ?? null;
	const displayed = session.displayedLineage;
	const displayedLineage: CapturedDisplayedLineage = displayed.kind === "unknown"
		? { kind: "unknown" }
		: {
			kind: "known",
			file: displayed.file,
			filePath: displayed.file.path,
			path: displayed.path,
			fileId: displayed.fileId,
			cm: displayed.cm,
			document: displayed.document,
			editorRevision: displayed.editorRevision,
		};
	const displayedDocumentContent = displayed.kind === "known"
		? displayed.document.toString()
		: null;
	const binding: CapturedBinding = session.binding.kind === "unbound"
		? { kind: "unbound" }
		: {
			kind: "bound",
			path: session.binding.path,
			fileId: session.binding.fileId,
			ytext: session.binding.ytext,
		};
	const liveHandoff = session.handoff;
	const handoff: CapturedHandoff = liveHandoff === null
		? null
		: {
			ref: liveHandoff,
			sourceAuthorityPath: liveHandoff.sourceAuthorityPath,
			sourceUnloadReceiptId: liveHandoff.sourceUnloadReceiptId,
			targetPath: liveHandoff.targetPath,
			targetFile: liveHandoff.targetFile,
			targetFilePath: liveHandoff.targetFile.path,
			bindingEpochAfterDetach: liveHandoff.bindingEpochAfterDetach,
			presentation: liveHandoff.presentation,
			inputGateInstalled: liveHandoff.inputGateInstalled,
			saveGuardInstalled: liveHandoff.saveGuardInstalled,
			pendingHostLoadCandidate: liveHandoff.pendingHostLoadCandidate,
		};
	const currentCm = pane.currentCm;
	const currentDocument = currentCm?.state.doc ?? null;
	const read = pane.read.kind === "failed"
		? { kind: "failed" } as const
		: { kind: "ok", content: pane.read.content } as const;
	const candidatePaths = uniqueSortedPaths([
		currentFilePath,
		displayed.kind === "known" ? displayed.path : null,
		session.binding.kind === "bound" ? session.binding.path : null,
		liveHandoff?.sourceAuthorityPath ?? null,
		liveHandoff?.targetPath ?? null,
	]);
	return {
		sortKey: `${session.leafId}\u0000${session.sessionId}`,
		session,
		sessionId: session.sessionId,
		leafId: session.leafId,
		generation: session.generation,
		eventOrderSeq: session.eventOrderSeq,
		currentSwitchIntentSeq: session.currentSwitchIntentSeq,
		nativeHistoryEpoch: session.nativeHistoryEpoch,
		completedDetachEpoch: session.completedDetachEpoch,
		completedSamePathInput: session.completedSamePathInput,
		pendingInputStartReservation: session.pendingInputStartReservation,
		view,
		currentFile,
		currentFilePath,
		displayedLineageRef: displayed,
		displayedLineage,
		displayedDocumentContent,
		bindingRef: session.binding,
		binding,
		handoff,
		currentCm,
		currentDocument,
		bindingEpoch: pane.bindingEpoch,
		editorRevision: pane.editorRevision,
		read,
		contentHash: read.kind === "ok" ? hashString(read.content) : null,
		candidatePaths,
	};
}

function isHealthyCandidate(pane: CapturedPane, path: string): boolean {
	const displayed = pane.displayedLineage;
	if (
		displayed.kind !== "known"
		|| displayed.path !== path
		|| displayed.filePath !== path
		|| pane.currentFile !== displayed.file
		|| pane.currentFilePath !== path
		|| pane.currentCm === null
		|| pane.currentCm !== displayed.cm
		|| pane.currentDocument !== displayed.document
		|| pane.editorRevision !== displayed.editorRevision
		|| !Number.isSafeInteger(pane.bindingEpoch)
		|| pane.bindingEpoch < 0
		|| !Number.isSafeInteger(pane.editorRevision)
		|| pane.editorRevision < 0
		|| pane.read.kind !== "ok"
	) {
		return false;
	}

	if (pane.read.content !== pane.displayedDocumentContent) return false;
	if (
		displayed.fileId === null
		&& (
			pane.binding.kind !== "unbound"
			|| pane.handoff !== null
				|| pane.currentSwitchIntentSeq !== null
				|| pane.completedDetachEpoch !== null
				|| pane.completedSamePathInput !== null
				|| pane.pendingInputStartReservation !== null
		)
	) {
		return false;
	}

	if (
		pane.binding.kind === "bound"
		&& (
			pane.binding.path !== path
			|| pane.binding.fileId !== displayed.fileId
		)
	) {
		return false;
	}

	return pane.handoff === null;
}

function fingerprintFileId(fileId: string | null): string {
	// Tag and length-prefix concrete IDs so a missing ID is never confused with
	// an empty string, the literal "null", or a delimiter-bearing concrete ID.
	return fileId === null ? "missing" : `concrete:${fileId.length}:${fileId}`;
}

function buildFingerprint(
	path: string,
	authorityEpoch: number,
	fileId: string | null,
	contentHash: string,
	panes: readonly CapturedPane[],
): string {
	const vector = panes.map((pane) => [
		pane.sortKey,
		pane.generation,
		pane.bindingEpoch,
		pane.editorRevision,
		pane.currentFilePath ?? "",
		pane.displayedLineage.kind === "known"
			? fingerprintFileId(pane.displayedLineage.fileId)
			: "unknown-lineage",
		pane.contentHash ?? "read-failed",
		pane.handoff?.presentation ?? "stable",
	].join("\u001f")).join("\u001e");
	return hashString(
		`${path}\u001d${authorityEpoch}\u001d${fingerprintFileId(fileId)}\u001d${contentHash}\u001d${vector}`,
	);
}

function captureAuthority(
	source: PathEditorAuthoritySource,
	path: string,
	epochTracker: AuthorityEpochTracker,
): CapturedAuthority {
	let authorityEpoch: number;
	let panes: CapturedPane[];
	let openViews: unknown[];
	try {
		authorityEpoch = readAuthorityEpoch(source, epochTracker);
		const capturedPanes: unknown = source.captureManagedPanes();
		const capturedOpenViews: unknown = source.captureOpenFileViews(path);
		const rawPanes = copyHostArray(capturedPanes);
		openViews = copyHostArray(capturedOpenViews);
		panes = new Array<CapturedPane>(rawPanes.length);
		for (let index = 0; index < rawPanes.length; index += 1) {
			panes[index] = capturePane(
				rawPanes[index] as PathEditorAuthorityManagedPane,
			);
		}
		const authorityEpochAfter = readAuthorityEpoch(source, epochTracker);
		if (authorityEpochAfter !== authorityEpoch) {
			return notProven(blocked("transitioning"));
		}
	} catch {
		return notProven(blocked("transitioning"));
	}
	panes.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
	for (let index = 1; index < panes.length; index += 1) {
		if (panes[index - 1]?.sortKey === panes[index]?.sortKey) {
			return notProven(blocked("transitioning"));
		}
	}

	const candidates = panes.filter((pane) => pane.candidatePaths.includes(path));
	if (candidates.length === 0) {
		return notProven(openViews.length === 0 ? NONE : blocked("unmanaged-view"));
	}

	for (const openView of openViews) {
		if (!candidates.some((pane) => pane.view === openView)) {
			return notProven(blocked("unmanaged-view"));
		}
	}
	for (const pane of candidates) {
		if (!openViews.some((openView) => openView === pane.view)) {
			return notProven(blocked("transitioning"));
		}
	}
	for (let index = 0; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		if (
			candidate !== undefined
			&& candidates.slice(0, index).some((other) => other.view === candidate.view)
		) {
			return notProven(blocked("transitioning"));
		}
	}
	for (let index = 0; index < openViews.length; index += 1) {
		const openView = openViews[index];
		if (openViews.slice(0, index).some((other) => other === openView)) {
			return notProven(blocked("transitioning"));
		}
	}

	if (candidates.some((pane) => pane.read.kind === "failed")) {
		return notProven(blocked("read-failed"));
	}
	if (candidates.some((pane) => !isHealthyCandidate(pane, path))) {
		return notProven(blocked("transitioning"));
	}

	const first = candidates[0];
	if (
		first === undefined
		|| first.displayedLineage.kind !== "known"
		|| first.read.kind !== "ok"
		|| first.contentHash === null
	) {
		return notProven(blocked("transitioning"));
	}
	const fileId = first.displayedLineage.fileId;
	const exactFile = first.displayedLineage.file;
	const content = first.read.content;
	const contentHash = first.contentHash;
	for (const pane of candidates.slice(1)) {
		if (
			pane.displayedLineage.kind !== "known"
			|| pane.read.kind !== "ok"
			|| pane.displayedLineage.file !== exactFile
			|| pane.displayedLineage.fileId !== fileId
			|| pane.read.content !== content
			|| pane.contentHash !== contentHash
		) {
			return notProven(blocked("multiple"));
		}
	}
	const canonicalOpenViews = [...openViews].sort((left, right) => {
		const leftKey = candidates.find((pane) => pane.view === left)?.sortKey ?? "";
		const rightKey = candidates.find((pane) => pane.view === right)?.sortKey ?? "";
		return leftKey.localeCompare(rightKey);
	});

	const proof: AuthorityProof = {
		requestedPath: path,
		authorityEpoch,
		fileId,
		content,
		contentHash,
		fingerprint: buildFingerprint(path, authorityEpoch, fileId, contentHash, panes),
		panes,
		openViews: canonicalOpenViews,
	};
	return {
		kind: "proven",
		content,
		proof,
	};
}

function sameDisplayed(
	left: CapturedDisplayedLineage,
	right: CapturedDisplayedLineage,
): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "unknown" || right.kind === "unknown") return true;
	return left.file === right.file
		&& left.filePath === right.filePath
		&& left.path === right.path
		&& left.fileId === right.fileId
		&& left.cm === right.cm
		&& left.document === right.document
		&& left.editorRevision === right.editorRevision;
}

function sameBinding(left: CapturedBinding, right: CapturedBinding): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "unbound" || right.kind === "unbound") return true;
	return left.path === right.path
		&& left.fileId === right.fileId
		&& left.ytext === right.ytext;
}

function sameHandoff(left: CapturedHandoff, right: CapturedHandoff): boolean {
	if (left === null || right === null) return left === right;
	return left.ref === right.ref
		&& left.sourceAuthorityPath === right.sourceAuthorityPath
		&& left.sourceUnloadReceiptId === right.sourceUnloadReceiptId
		&& left.targetPath === right.targetPath
		&& left.targetFile === right.targetFile
		&& left.targetFilePath === right.targetFilePath
		&& left.bindingEpochAfterDetach === right.bindingEpochAfterDetach
		&& left.presentation === right.presentation
		&& left.inputGateInstalled === right.inputGateInstalled
		&& left.saveGuardInstalled === right.saveGuardInstalled
		&& left.pendingHostLoadCandidate === right.pendingHostLoadCandidate;
}

function sameStringVector(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((value, index) => value === right[index]);
}

function samePane(left: CapturedPane, right: CapturedPane): boolean {
	return left.sortKey === right.sortKey
		&& left.session === right.session
		&& left.sessionId === right.sessionId
		&& left.leafId === right.leafId
		&& left.generation === right.generation
		&& left.eventOrderSeq === right.eventOrderSeq
		&& left.currentSwitchIntentSeq === right.currentSwitchIntentSeq
		&& left.nativeHistoryEpoch === right.nativeHistoryEpoch
		&& left.completedDetachEpoch === right.completedDetachEpoch
		&& left.completedSamePathInput === right.completedSamePathInput
		&& left.pendingInputStartReservation === right.pendingInputStartReservation
		&& left.view === right.view
		&& left.currentFile === right.currentFile
		&& left.currentFilePath === right.currentFilePath
		&& left.displayedLineageRef === right.displayedLineageRef
		&& sameDisplayed(left.displayedLineage, right.displayedLineage)
		&& left.displayedDocumentContent === right.displayedDocumentContent
		&& left.bindingRef === right.bindingRef
		&& sameBinding(left.binding, right.binding)
		&& sameHandoff(left.handoff, right.handoff)
		&& left.currentCm === right.currentCm
		&& left.currentDocument === right.currentDocument
		&& left.bindingEpoch === right.bindingEpoch
		&& left.editorRevision === right.editorRevision
		&& left.read.kind === right.read.kind
		&& (left.read.kind !== "ok" || (right.read.kind === "ok" && left.read.content === right.read.content))
		&& left.contentHash === right.contentHash
		&& sameStringVector(left.candidatePaths, right.candidatePaths);
}

function sameProof(left: AuthorityProof, right: AuthorityProof): boolean {
	if (
		left.requestedPath !== right.requestedPath
		|| left.authorityEpoch !== right.authorityEpoch
		|| left.fileId !== right.fileId
		|| left.content !== right.content
		|| left.contentHash !== right.contentHash
		|| left.fingerprint !== right.fingerprint
		|| left.panes.length !== right.panes.length
		|| left.openViews.length !== right.openViews.length
	) {
		return false;
	}
	for (let index = 0; index < left.panes.length; index += 1) {
		const leftPane = left.panes[index];
		const rightPane = right.panes[index];
		if (leftPane === undefined || rightPane === undefined || !samePane(leftPane, rightPane)) {
			return false;
		}
	}
	for (let index = 0; index < left.openViews.length; index += 1) {
		if (left.openViews[index] !== right.openViews[index]) return false;
	}
	return true;
}

export function createPathEditorAuthorityPort(
	source: PathEditorAuthoritySource,
): PathEditorAuthorityPort {
	const entriesByLeaseId = new Map<string, LeaseEntry>();
	const entriesByLease = new WeakMap<object, LeaseEntry>();
	const currentEntryByPath = new Map<string, LeaseEntry>();
	const epochTracker: AuthorityEpochTracker = {
		highestObserved: -1,
		poisoned: false,
	};
	let collisionCounter = 0;

	function retireEntry(entry: LeaseEntry): void {
		entriesByLease.delete(entry.lease);
		if (entriesByLeaseId.get(entry.leaseId) === entry) {
			entriesByLeaseId.delete(entry.leaseId);
		}
		if (currentEntryByPath.get(entry.proof.requestedPath) === entry) {
			currentEntryByPath.delete(entry.proof.requestedPath);
		}
	}

	function retireAllEntries(): void {
		for (const entry of [...currentEntryByPath.values()]) retireEntry(entry);
	}

	function failClosedIfEpochPoisoned(): boolean {
		if (!epochTracker.poisoned) return false;
		retireAllEntries();
		return true;
	}

	function pruneStaleEntries(exceptPath: string): void {
		if (failClosedIfEpochPoisoned()) return;
		for (const [path, entry] of [...currentEntryByPath.entries()]) {
			if (path === exceptPath) continue;
			const current = captureAuthority(source, path, epochTracker);
			if (failClosedIfEpochPoisoned()) return;
			if (current.kind !== "proven" || !sameProof(entry.proof, current.proof)) {
				retireEntry(entry);
			}
		}
	}

	function nextLeaseId(): string {
		const nonce = source.createLeaseNonce?.() ?? defaultLeaseNonce();
		if (typeof nonce !== "string" || nonce.length === 0) {
			throw new Error("Invalid editor-authority nonce");
		}
		let leaseId = nonce;
		while (entriesByLeaseId.has(leaseId)) {
			collisionCounter += 1;
			leaseId = `${nonce}:${collisionCounter}`;
		}
		return leaseId;
	}

	return {
		capturePathEditorAuthority(path: string): PathEditorAuthority {
			// Keep multiple concurrently current paths reusable, while ensuring a
			// sequence of note switches cannot retain one strong lease per historical
			// path forever. The requested path is captured last, after this pure sweep.
			pruneStaleEntries(path);
			if (failClosedIfEpochPoisoned()) return blocked("transitioning");
			const captured = captureAuthority(source, path, epochTracker);
			if (failClosedIfEpochPoisoned()) return blocked("transitioning");
			const previousEntry = currentEntryByPath.get(path);
			if (captured.kind === "not-proven") {
				if (previousEntry !== undefined) retireEntry(previousEntry);
				return captured.authority;
			}
			if (
				previousEntry !== undefined
				&& sameProof(previousEntry.proof, captured.proof)
			) {
				return Object.freeze({
					kind: "proven-single",
					content: captured.content,
					lease: previousEntry.lease,
				});
			}
			if (previousEntry !== undefined) retireEntry(previousEntry);

			let leaseId: string;
			try {
				leaseId = nextLeaseId();
			} catch {
				return blocked("transitioning");
			}
			const confirmed = captureAuthority(source, path, epochTracker);
			if (failClosedIfEpochPoisoned()) return blocked("transitioning");
			if (
				confirmed.kind !== "proven"
				|| !sameProof(captured.proof, confirmed.proof)
			) {
				return blocked("transitioning");
			}
			const lease = Object.freeze({ leaseId }) as EditorAuthorityLease;
			const entry: LeaseEntry = { lease, leaseId, proof: confirmed.proof };
			entriesByLeaseId.set(leaseId, entry);
			entriesByLease.set(lease, entry);
			currentEntryByPath.set(path, entry);
			return Object.freeze({
				kind: "proven-single",
				content: captured.content,
				lease,
			});
		},

		isLeaseCurrent(lease: EditorAuthorityLease): boolean {
			if (failClosedIfEpochPoisoned()) return false;
			if (lease === null || typeof lease !== "object") return false;
			const entry = entriesByLease.get(lease);
			if (
				entry === undefined
				|| entry.lease !== lease
				|| entriesByLeaseId.get(entry.leaseId) !== entry
				|| currentEntryByPath.get(entry.proof.requestedPath) !== entry
			) {
				return false;
			}

			const current = captureAuthority(
				source,
				entry.proof.requestedPath,
				epochTracker,
			);
			if (failClosedIfEpochPoisoned()) return false;
			if (
				current.kind === "proven"
				&& sameProof(entry.proof, current.proof)
			) {
				return true;
			}

			retireEntry(entry);
			return false;
		},
	};
}
