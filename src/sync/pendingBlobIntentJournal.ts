import { normalizePath } from "obsidian";
import {
	MAX_BLOB_REF_PRIOR_HASHES,
	cloneBlobRef,
	isSha256Hex,
	type BlobRef,
} from "../types";

export interface PendingBlobIntentScope {
	host: string;
	vaultId: string;
	localDeviceId: string;
}

export interface PendingBlobMutationBase {
	known: boolean;
	ref?: BlobRef;
	/** Exact Y.Map item episode for a live source ref. */
	sourceVersionKnown?: boolean;
	expectedSourceVersion?: string;
}

interface PendingBlobIntentCommon {
	id: string;
	recordedAt: number;
	scope: PendingBlobIntentScope;
	baseRefKnown: boolean;
	expectedSourceRef?: BlobRef;
	/** Missing on legacy records, which therefore fail closed for a live ref. */
	sourceVersionKnown?: boolean;
	expectedSourceVersion?: string;
	/** Durable write-ahead fence installed before the CRDT CAS is attempted. */
	commitAttemptId?: string;
	attemptedAt?: number;
	attemptSessionId?: string;
	committedAt?: number;
	receiptCandidateId?: string;
	commitSessionId?: string;
	/** Exact tombstone episode produced/accepted by the committed mutation. */
	commitDeleteFingerprint?: string;
}

export type PendingBlobIntent =
	| PendingBlobIntentCommon & {
		kind: "delete";
		path: string;
	}
	| PendingBlobIntentCommon & {
		kind: "rename";
		oldPath: string;
		newPath: string;
	};

export function pendingBlobIntentsOverlap(
	left: PendingBlobIntent,
	right: PendingBlobIntent,
): boolean {
	const leftPaths = new Set(left.kind === "delete"
		? [left.path]
		: [left.oldPath, left.newPath]
	);
	const rightPaths = right.kind === "delete"
		? [right.path]
		: [right.oldPath, right.newPath];
	return rightPaths.some((path) => leftPaths.has(path));
}

let intentSequence = 0;

function createIntentId(at: number): string {
	intentSequence = (intentSequence + 1) % Number.MAX_SAFE_INTEGER;
	return `${at.toString(36)}-${intentSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sameScope(left: PendingBlobIntentScope, right: PendingBlobIntentScope): boolean {
	return left.host === right.host
		&& left.vaultId === right.vaultId
		&& left.localDeviceId === right.localDeviceId;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isBlobSourceVersion(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d+:\d+$/.test(value)) return false;
	const [client, clock] = value.split(":").map(Number);
	return Number.isSafeInteger(client)
		&& client! >= 0
		&& Number.isSafeInteger(clock)
		&& clock! >= 0;
}

function isValidTimestamp(value: unknown): value is number {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value >= 0;
}

function isReadyToCommit(intent: PendingBlobIntent): boolean {
	return intent.commitAttemptId === undefined
		&& intent.attemptedAt === undefined
		&& intent.attemptSessionId === undefined
		&& intent.committedAt === undefined
		&& intent.receiptCandidateId === undefined
		&& intent.commitSessionId === undefined
		&& intent.commitDeleteFingerprint === undefined;
}

function hasExactCommitAttempt(
	intent: PendingBlobIntent,
	commitAttemptId: string,
): boolean {
	return intent.commitAttemptId === commitAttemptId
		&& intent.attemptedAt !== undefined
		&& intent.attemptSessionId !== undefined
		&& intent.committedAt === undefined
		&& intent.receiptCandidateId === undefined
		&& intent.commitSessionId === undefined
		&& intent.commitDeleteFingerprint === undefined;
}

function cloneIntent(intent: PendingBlobIntent): PendingBlobIntent {
	return {
		...intent,
		scope: { ...intent.scope },
		expectedSourceRef: cloneBlobRef(intent.expectedSourceRef),
	};
}

function readScope(value: unknown): PendingBlobIntentScope | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.host === "string"
		&& candidate.host.length > 0
		&& typeof candidate.vaultId === "string"
		&& candidate.vaultId.length > 0
		&& typeof candidate.localDeviceId === "string"
		&& candidate.localDeviceId.length > 0
		? {
			host: candidate.host,
			vaultId: candidate.vaultId,
			localDeviceId: candidate.localDeviceId,
		}
		: null;
}

function readBlobRef(value: unknown): BlobRef | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if (!Object.keys(candidate).every((key) =>
		key === "hash" || key === "size" || key === "priorHashes")) return undefined;
	if (
		!isSha256Hex(candidate.hash)
		|| typeof candidate.size !== "number"
		|| !Number.isSafeInteger(candidate.size)
		|| candidate.size < 0
	) return undefined;
	if (candidate.priorHashes === undefined) {
		return { hash: candidate.hash, size: candidate.size };
	}
	if (
		!Array.isArray(candidate.priorHashes)
		|| candidate.priorHashes.length > MAX_BLOB_REF_PRIOR_HASHES
	) return undefined;
	const priorHashes: string[] = [];
	for (const hash of candidate.priorHashes) {
		if (
			!isSha256Hex(hash)
			|| hash === candidate.hash
			|| priorHashes.includes(hash)
		) return undefined;
		priorHashes.push(hash);
	}
	return priorHashes.length > 0
		? { hash: candidate.hash, size: candidate.size, priorHashes }
		: { hash: candidate.hash, size: candidate.size };
}

function readIntent(value: unknown): PendingBlobIntent | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const commonKeys = new Set([
		"id",
		"kind",
		"recordedAt",
		"scope",
		"baseRefKnown",
		"expectedSourceRef",
		"sourceVersionKnown",
		"expectedSourceVersion",
		"commitAttemptId",
		"attemptedAt",
		"attemptSessionId",
		"committedAt",
		"receiptCandidateId",
		"commitSessionId",
		"commitDeleteFingerprint",
	]);
	const pathKeys = candidate.kind === "delete"
		? new Set([...commonKeys, "path"])
		: candidate.kind === "rename"
			? new Set([...commonKeys, "oldPath", "newPath"])
			: null;
	if (!pathKeys || !Object.keys(candidate).every((key) => pathKeys.has(key))) return null;
	const scope = readScope(candidate.scope);
	if (
		typeof candidate.id !== "string"
		|| candidate.id.length === 0
		|| typeof candidate.recordedAt !== "number"
		|| !Number.isSafeInteger(candidate.recordedAt)
		|| candidate.recordedAt < 0
		|| !scope
		|| typeof candidate.baseRefKnown !== "boolean"
	) {
		return null;
	}
	const expectedSourceRef = candidate.baseRefKnown
		? readBlobRef(candidate.expectedSourceRef)
		: undefined;
	if (candidate.baseRefKnown && candidate.expectedSourceRef !== undefined && !expectedSourceRef) {
		return null;
	}
	if (!candidate.baseRefKnown && candidate.expectedSourceRef !== undefined) return null;
	if (
		candidate.sourceVersionKnown !== undefined
		&& typeof candidate.sourceVersionKnown !== "boolean"
	) return null;
	const sourceVersionKnown = candidate.sourceVersionKnown === true;
	const expectedSourceVersion = candidate.expectedSourceVersion === undefined
		? undefined
		: isBlobSourceVersion(candidate.expectedSourceVersion)
			? candidate.expectedSourceVersion
			: null;
	if (expectedSourceVersion === null) return null;
	if (!sourceVersionKnown && expectedSourceVersion !== undefined) return null;
	if (sourceVersionKnown && expectedSourceRef && expectedSourceVersion === undefined) return null;
	if (expectedSourceVersion !== undefined && !expectedSourceRef) return null;
	if (candidate.commitAttemptId !== undefined && !isNonEmptyString(candidate.commitAttemptId)) {
		return null;
	}
	const commitAttemptId = candidate.commitAttemptId;
	if (candidate.attemptedAt !== undefined && !isValidTimestamp(candidate.attemptedAt)) {
		return null;
	}
	const attemptedAt = candidate.attemptedAt;
	if (candidate.attemptSessionId !== undefined && !isNonEmptyString(candidate.attemptSessionId)) {
		return null;
	}
	const attemptSessionId = candidate.attemptSessionId;
	if (candidate.committedAt !== undefined && !isValidTimestamp(candidate.committedAt)) return null;
	const committedAt = candidate.committedAt;
	if (
		candidate.receiptCandidateId !== undefined
		&& !isNonEmptyString(candidate.receiptCandidateId)
	) return null;
	const receiptCandidateId = candidate.receiptCandidateId;
	if (
		candidate.commitSessionId !== undefined
		&& !isNonEmptyString(candidate.commitSessionId)
	) return null;
	const commitSessionId = candidate.commitSessionId;
	if (
		candidate.commitDeleteFingerprint !== undefined
		&& !isNonEmptyString(candidate.commitDeleteFingerprint)
	) return null;
	const commitDeleteFingerprint = typeof candidate.commitDeleteFingerprint === "string"
		? candidate.commitDeleteFingerprint
		: undefined;
	const hasAttemptMetadata = commitAttemptId !== undefined
		|| attemptedAt !== undefined
		|| attemptSessionId !== undefined;
	const hasCommitMetadata = committedAt !== undefined
		|| receiptCandidateId !== undefined
		|| commitSessionId !== undefined
		|| commitDeleteFingerprint !== undefined;
	if (hasAttemptMetadata) {
		// An attempted record is the durable pre-CAS fence. Partial attempt
		// metadata, or mixing it with post-CAS metadata, cannot be trusted.
		if (
			!commitAttemptId
			|| attemptedAt === undefined
			|| !attemptSessionId
			|| hasCommitMetadata
		) return null;
	} else if (hasCommitMetadata) {
		// A committed record requires both its linearization time and session.
		if (committedAt === undefined || !commitSessionId) return null;
	}
	const common: PendingBlobIntentCommon = {
		id: candidate.id,
		recordedAt: candidate.recordedAt,
		scope,
		baseRefKnown: candidate.baseRefKnown,
		expectedSourceRef,
		sourceVersionKnown,
		expectedSourceVersion,
		commitAttemptId,
		attemptedAt,
		attemptSessionId,
		committedAt,
		receiptCandidateId,
		commitSessionId,
		commitDeleteFingerprint,
	};
	if (candidate.kind === "delete" && typeof candidate.path === "string") {
		const path = normalizePath(candidate.path);
		return path
			? { ...common, kind: "delete", path }
			: null;
	}
	if (
		candidate.kind === "rename"
		&& typeof candidate.oldPath === "string"
		&& typeof candidate.newPath === "string"
	) {
		const oldPath = normalizePath(candidate.oldPath);
		const newPath = normalizePath(candidate.newPath);
		return oldPath && newPath && oldPath !== newPath
			? {
				...common,
				kind: "rename",
				oldPath,
				newPath,
			}
			: null;
	}
	return null;
}

/**
 * Durable local intent journal for attachment mutations observed before the
 * provider has supplied authoritative CRDT state. Entries are removed only
 * after the caller has checked the current disk postcondition and committed
 * the matching CRDT mutation.
 */
export class PendingBlobIntentJournal {
	private entries: PendingBlobIntent[] = [];

	constructor(entries: unknown = []) {
		this.hydrate(entries);
	}

	hydrate(entries: unknown): void {
		this.entries = Array.isArray(entries)
			? entries.map(readIntent).filter((entry): entry is PendingBlobIntent => entry !== null)
			: [];
	}

	recordDelete(
		path: string,
		scope: PendingBlobIntentScope,
		base: PendingBlobMutationBase,
		recordedAt = Date.now(),
	): PendingBlobIntent {
		let normalized = normalizePath(path);
		let effectiveBase = base;

		// A -> B followed by deleting B means the durable remote postcondition is
		// deletion of A. Collapse the chain so a restart cannot resurrect A.
		for (;;) {
			const sourceRename = this.entries.find(
				(entry): entry is Extract<PendingBlobIntent, { kind: "rename" }> =>
					entry.kind === "rename"
					&& sameScope(entry.scope, scope)
					&& isReadyToCommit(entry)
					&& entry.newPath === normalized,
			);
			if (!sourceRename) break;
			normalized = sourceRename.oldPath;
			effectiveBase = {
				known: sourceRename.baseRefKnown,
				ref: cloneBlobRef(sourceRename.expectedSourceRef),
				sourceVersionKnown: sourceRename.sourceVersionKnown === true,
				expectedSourceVersion: sourceRename.expectedSourceVersion,
			};
			this.remove(sourceRename.id);
		}

		const existing = this.entries.find(
			(entry): entry is Extract<PendingBlobIntent, { kind: "delete" }> =>
				entry.kind === "delete"
				&& sameScope(entry.scope, scope)
				&& isReadyToCommit(entry)
				&& entry.path === normalized,
		);
		if (existing) {
			return cloneIntent(existing);
		}

		this.entries = this.entries.filter(
			(entry) => !(entry.kind === "rename"
				&& sameScope(entry.scope, scope)
				&& isReadyToCommit(entry)
				&& entry.oldPath === normalized),
		);
		const intent: PendingBlobIntent = {
			id: createIntentId(recordedAt),
			kind: "delete",
			path: normalized,
			recordedAt,
			scope: { ...scope },
			baseRefKnown: effectiveBase.known,
			expectedSourceRef: effectiveBase.known
				? cloneBlobRef(effectiveBase.ref)
				: undefined,
			sourceVersionKnown: effectiveBase.sourceVersionKnown === true,
			expectedSourceVersion: effectiveBase.sourceVersionKnown
				? effectiveBase.expectedSourceVersion
				: undefined,
		};
		this.push(intent);
		return cloneIntent(intent);
	}

	recordRename(
		oldPath: string,
		newPath: string,
		scope: PendingBlobIntentScope,
		base: PendingBlobMutationBase,
		recordedAt = Date.now(),
	): PendingBlobIntent | null {
		const normalizedOld = normalizePath(oldPath);
		const normalizedNew = normalizePath(newPath);
		if (!normalizedOld || !normalizedNew || normalizedOld === normalizedNew) return null;

		// A prior delete at the source owns the remote postcondition. The current
		// destination is a fresh local admission and will be handled by reconcile.
		if (this.entries.some((entry) => entry.kind === "delete"
			&& sameScope(entry.scope, scope)
			&& isReadyToCommit(entry)
			&& entry.path === normalizedOld)) {
			return null;
		}

		const chained = this.entries.find(
			(entry): entry is Extract<PendingBlobIntent, { kind: "rename" }> =>
				entry.kind === "rename"
				&& sameScope(entry.scope, scope)
				&& isReadyToCommit(entry)
				&& entry.newPath === normalizedOld,
		);
		const existing = chained ?? this.entries.find(
			(entry): entry is Extract<PendingBlobIntent, { kind: "rename" }> =>
				entry.kind === "rename"
				&& sameScope(entry.scope, scope)
				&& isReadyToCommit(entry)
				&& entry.oldPath === normalizedOld,
		);
		if (existing) {
			if (existing.oldPath === normalizedNew) {
				this.remove(existing.id);
				return null;
			}
			existing.newPath = normalizedNew;
			existing.recordedAt = recordedAt;
			return cloneIntent(existing);
		}

		const intent: PendingBlobIntent = {
			id: createIntentId(recordedAt),
			kind: "rename",
			oldPath: normalizedOld,
			newPath: normalizedNew,
			recordedAt,
			scope: { ...scope },
			baseRefKnown: base.known,
			expectedSourceRef: base.known ? cloneBlobRef(base.ref) : undefined,
			sourceVersionKnown: base.sourceVersionKnown === true,
			expectedSourceVersion: base.sourceVersionKnown
				? base.expectedSourceVersion
				: undefined,
		};
		this.push(intent);
		return cloneIntent(intent);
	}

	remove(id: string): boolean {
		const index = this.entries.findIndex((entry) => entry.id === id);
		if (index < 0) return false;
		this.entries.splice(index, 1);
		return true;
	}

	markCommitted(
		id: string,
		committedAt: number,
		commitSessionId: string,
		receiptCandidateId?: string | null,
		commitDeleteFingerprint?: string | null,
	): boolean {
		if (
			!isValidTimestamp(committedAt)
			|| !isNonEmptyString(commitSessionId)
			|| (receiptCandidateId != null && !isNonEmptyString(receiptCandidateId))
			|| (commitDeleteFingerprint != null && !isNonEmptyString(commitDeleteFingerprint))
		) return false;
		const entry = this.entries.find((candidate) => candidate.id === id);
		if (!entry || !isReadyToCommit(entry)) return false;
		entry.committedAt = committedAt;
		entry.commitSessionId = commitSessionId;
		if (receiptCandidateId) entry.receiptCandidateId = receiptCandidateId;
		else delete entry.receiptCandidateId;
		if (commitDeleteFingerprint) entry.commitDeleteFingerprint = commitDeleteFingerprint;
		else delete entry.commitDeleteFingerprint;
		return true;
	}

	/** Install and identify the durable pre-CAS fence for one ready intent. */
	markCommitAttempted(
		id: string,
		commitAttemptId: string,
		attemptedAt: number,
		attemptSessionId: string,
	): boolean {
		if (
			!isNonEmptyString(commitAttemptId)
			|| !isValidTimestamp(attemptedAt)
			|| !isNonEmptyString(attemptSessionId)
		) return false;
		const entry = this.entries.find((candidate) => candidate.id === id);
		if (!entry || !isReadyToCommit(entry)) return false;
		entry.commitAttemptId = commitAttemptId;
		entry.attemptedAt = attemptedAt;
		entry.attemptSessionId = attemptSessionId;
		return true;
	}

	/**
	 * Return an exact, known-no-mutation attempt to ready state. A stale async
	 * continuation cannot clear a newer attempt because its ID must still match.
	 */
	clearCommitAttempt(id: string, commitAttemptId: string): boolean {
		if (!isNonEmptyString(commitAttemptId)) return false;
		const entry = this.entries.find((candidate) => candidate.id === id);
		if (!entry || !hasExactCommitAttempt(entry, commitAttemptId)) return false;
		delete entry.commitAttemptId;
		delete entry.attemptedAt;
		delete entry.attemptSessionId;
		return true;
	}

	/** Advance the exact durable pre-CAS attempt to committed/unconfirmed. */
	markCommittedFromAttempt(
		id: string,
		commitAttemptId: string,
		committedAt: number,
		commitSessionId: string,
		receiptCandidateId?: string | null,
		commitDeleteFingerprint?: string | null,
	): boolean {
		if (
			!isNonEmptyString(commitAttemptId)
			|| !isValidTimestamp(committedAt)
			|| !isNonEmptyString(commitSessionId)
			|| (receiptCandidateId != null && !isNonEmptyString(receiptCandidateId))
			|| (commitDeleteFingerprint != null && !isNonEmptyString(commitDeleteFingerprint))
		) return false;
		const entry = this.entries.find((candidate) => candidate.id === id);
		if (!entry || !hasExactCommitAttempt(entry, commitAttemptId)) return false;
		delete entry.commitAttemptId;
		delete entry.attemptedAt;
		delete entry.attemptSessionId;
		entry.committedAt = committedAt;
		entry.commitSessionId = commitSessionId;
		if (receiptCandidateId) entry.receiptCandidateId = receiptCandidateId;
		else delete entry.receiptCandidateId;
		if (commitDeleteFingerprint) entry.commitDeleteFingerprint = commitDeleteFingerprint;
		else delete entry.commitDeleteFingerprint;
		return true;
	}

	clear(): void {
		this.entries = [];
	}

	getEntries(scope?: PendingBlobIntentScope): PendingBlobIntent[] {
		return this.entries
			.filter((entry) => !scope || sameScope(entry.scope, scope))
			.map(cloneIntent);
	}

	hasPath(path: string, scope?: PendingBlobIntentScope): boolean {
		const normalized = normalizePath(path);
		return this.entries.some((entry) => {
			if (scope && !sameScope(entry.scope, scope)) return false;
			if (entry.kind === "delete") return entry.path === normalized;
			return entry.oldPath === normalized
				|| (entry.committedAt === undefined && entry.newPath === normalized);
		});
	}

	get size(): number {
		return this.entries.length;
	}

	private push(intent: PendingBlobIntent): void {
		this.entries.push(intent);
	}
}
