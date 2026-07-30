import { ChangeSet, EditorSelection, Text } from "@codemirror/state";
import { digest as sha256Digest } from "lib0/hash/sha256";
import type { HandoffInputIntent } from "./editorHandoffState";

export const HANDOFF_RECOVERY_SCHEMA_VERSION = 1;
export const HANDOFF_RECOVERY_PROOF_SCHEMA_VERSION = 1;
export const HANDOFF_RECOVERY_CANONICAL_ENCODING_VERSION = 1;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const MAX_RECOVERY_STRING_LENGTH = 4096;

export type HandoffRecoveryScope = Readonly<{
	schemaVersion: number;
	vaultId: string;
	localDeviceId: string;
}>;

export type HandoffRecoveryApplyWitness = Readonly<{
	planId: string;
	kind: "exact-replay" | "strict-nonoverlap-rebase";
	switchIntentSeq: number;
	hostLoadTokenId: string;
	targetFileId: string;
	targetYtextIdentity: string;
	targetMutationEpochAtPlan: number;
	nativeHistoryEpoch: number;
	targetSelectionEpoch: number;
	targetScrollEpoch: number;
	plannedStartHash: string;
	plannedResultContent: string;
	plannedResultHash: string;
	serializedMappedSelection: string;
	dispatchReceiptHash: string | null;
}>;

export type ActiveHandoffRecoveryRecord = Readonly<{
	recordId: string;
	intentId: string;
	intentEnvelopeHash: string;
	scope: HandoffRecoveryScope;
	fromPath: string | null;
	targetPath: string;
	originKind: "user" | "ime" | "editor-api";
	sequenceBegan: "before-handoff" | "after-target-selected";
	startContentHash: string;
	afterContentHash: string;
	body: Readonly<{
		startContent: string;
		afterContent: string;
		serializedChanges: string;
		serializedSelectionBefore: string;
		serializedSelectionAfter: string;
		eventProof: Readonly<{
			proofSchemaVersion: number;
			canonicalEncodingVersion: number;
			sessionId: string;
			leafId: string;
			handoffGeneration: number;
			bindingEpoch: number;
			inputEpoch: number;
			switchIntentSeq: number;
			inputStartSeq: number;
			inputStartedUnderSwitchSeq: number | null;
			compositionEpoch: number | null;
			selectionEpoch: number;
		}>;
	}>;
	applyWitness: HandoffRecoveryApplyWitness | null;
	checksum: string;
	capturedAt: number;
	storedAt: number;
	status:
		| "stored"
		| "replay-pending"
		| "replayed-awaiting-settlement"
		| "needs-review";
}>;

export type TerminalHandoffRecoveryReceipt = Readonly<
	{
		recordId: string;
		intentId: string;
		intentEnvelopeHash: string;
		scope: HandoffRecoveryScope;
		fromPath: string | null;
		targetPath: string;
		startContentHash: string;
		afterContentHash: string;
		checksum: string;
		finalizedAt: number;
	} & (
		| {
			status: "resolved";
			disposition: "settled-replay" | "manual-resolution";
		}
		| { status: "discarded"; disposition: "discard" }
	)
>;

export type HandoffRecoveryRecord =
	| ActiveHandoffRecoveryRecord
	| TerminalHandoffRecoveryReceipt;

export type HandoffRecoveryIntentEnvelopeHash = string;

export type HandoffRecoveryStatusTransition = Readonly<{
	from: "stored" | "replay-pending" | "replayed-awaiting-settlement";
	to: "needs-review";
}>;

export type HandoffRecoveryCasResult =
	| { kind: "updated"; record: HandoffRecoveryRecord }
	| { kind: "unchanged"; record: HandoffRecoveryRecord }
	| { kind: "missing" }
	| {
		kind: "stale";
		actualStatus: HandoffRecoveryRecord["status"];
		actualChecksum: string;
	}
	| {
		kind: "fenced";
		action: "copy" | "export" | "discard";
		retainedRecord: HandoffRecoveryRecord | null;
	};

export type PutHandoffRecoveryIntentResult =
	| { kind: "stored"; record: ActiveHandoffRecoveryRecord }
	| { kind: "existing"; record: HandoffRecoveryRecord }
	| {
		kind: "fenced";
		action: "copy" | "export" | "discard";
		retainedRecord: HandoffRecoveryRecord | null;
	};

export type ResolveHandoffRecoveryRequest =
	| Readonly<{
		kind: "finalize-active";
		recordId: string;
		expectedChecksum: string;
		disposition: "settled-replay" | "manual-resolution" | "discard";
		finalizedAt: number;
	}>
	| Readonly<{
		kind: "precommit-escape";
		intentId: string;
		action: "copy" | "export" | "discard";
	}>;

export type ResolveHandoffRecoveryResult =
	| HandoffRecoveryCasResult
	| {
		kind: "escaped";
		action: "copy" | "export" | "discard";
		recordId: null;
	}
	| {
		kind: "retained";
		action: "copy" | "export" | "discard";
		record: HandoffRecoveryRecord;
	};

export type HandoffRecoveryHydrationIssue =
	| { kind: "corrupt"; recordId: string | null }
	| {
		kind: "incompatible-schema";
		recordId: string;
		schemaVersion: number;
	};

export type HandoffRecoveryHydrationResult = Readonly<{
	status: "missing" | "loaded" | "degraded";
	active: readonly ActiveHandoffRecoveryRecord[];
	terminal: readonly TerminalHandoffRecoveryReceipt[];
	issues: readonly HandoffRecoveryHydrationIssue[];
	totalBytes: number;
}>;

export type ClearHandoffRecoveryScopeResult =
	| { kind: "cleared"; deletedCount: number }
	| {
		kind: "blocked";
		reason: "replayed-awaiting-settlement";
		recordIds: readonly string[];
	};

export interface HandoffRecoveryStore {
	readonly scope: HandoffRecoveryScope;
	putIntent(intent: HandoffInputIntent): Promise<PutHandoffRecoveryIntentResult>;
	compareAndSetStatus(
		recordId: string,
		expectedChecksum: string,
		transition: HandoffRecoveryStatusTransition,
	): Promise<HandoffRecoveryCasResult>;
	storeApplyWitness(
		recordId: string,
		expectedChecksum: string,
		witness: HandoffRecoveryApplyWitness,
	): Promise<HandoffRecoveryCasResult>;
	storeDispatchReceipt(
		recordId: string,
		expectedChecksum: string,
		dispatchReceiptHash: string,
	): Promise<HandoffRecoveryCasResult>;
	resolveRecord(
		request: ResolveHandoffRecoveryRequest,
	): Promise<ResolveHandoffRecoveryResult>;
	hydrateScope(): Promise<HandoffRecoveryHydrationResult>;
	clearScope(): Promise<ClearHandoffRecoveryScopeResult>;
	drain(): Promise<void>;
}

export function canonicalHandoffRecoveryJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("Recovery values must be finite");
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalHandoffRecoveryJson).join(",")}]`;
	}
	if (typeof value === "object") {
		const prototype: unknown = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("Recovery values must be plain objects");
		}
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map((key) => {
			if (record[key] === undefined) {
				throw new Error(`Recovery field "${key}" is undefined`);
			}
			return `${JSON.stringify(key)}:${canonicalHandoffRecoveryJson(record[key])}`;
		}).join(",")}}`;
	}
	throw new Error(`Unsupported recovery value type: ${typeof value}`);
}

export function assertNonEmptyString(
	value: unknown,
	name: string,
): asserts value is string {
	if (
		typeof value !== "string"
		|| value.length === 0
		|| value !== value.trim()
		|| value.includes("\0")
		|| value.length > MAX_RECOVERY_STRING_LENGTH
	) {
		throw new Error(`${name} must be a non-empty bounded string`);
	}
}

export function assertSafeTimestamp(
	value: unknown,
	name: string,
): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${name} must be a non-negative safe integer`);
	}
}

export function assertSha256Hex(
	value: unknown,
	name: string,
): asserts value is string {
	if (typeof value !== "string" || !SHA256_HEX_RE.test(value)) {
		throw new Error(`${name} must be a lowercase SHA-256 hex digest`);
	}
}

export function assertHandoffRecoveryScope(
	value: unknown,
): asserts value is HandoffRecoveryScope {
	assertPlainRecord(value, "scope");
	assertExactKeys(value, ["schemaVersion", "vaultId", "localDeviceId"], "scope");
	if (value.schemaVersion !== HANDOFF_RECOVERY_SCHEMA_VERSION) {
		throw new Error(`schemaVersion must equal ${HANDOFF_RECOVERY_SCHEMA_VERSION}`);
	}
	assertNonEmptyString(value.vaultId, "vaultId");
	assertNonEmptyString(value.localDeviceId, "localDeviceId");
}

export function buildHandoffRecoveryRecordId(
	scope: HandoffRecoveryScope,
	intentId: string,
): string {
	assertHandoffRecoveryScope(scope);
	assertNonEmptyString(intentId, "intentId");
	return canonicalHandoffRecoveryJson([
		"kaos-handoff-recovery",
		scope.schemaVersion,
		scope.vaultId,
		scope.localDeviceId,
		intentId,
	]);
}

export function buildHandoffRecoveryScopeKey(scope: HandoffRecoveryScope): string {
	assertHandoffRecoveryScope(scope);
	return canonicalHandoffRecoveryJson([
		"kaos-handoff-recovery-scope",
		scope.schemaVersion,
		scope.vaultId,
		scope.localDeviceId,
	]);
}

export async function sha256HandoffRecoveryHex(value: string): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error("crypto.subtle is unavailable");
	}
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Capture-time SHA-256 for CodeMirror's synchronous transaction boundary.
 *
 * WebCrypto is promise-only, but an interrupted transaction must carry the
 * exact recovery-store digest before control returns to the host dispatcher.
 */
export function sha256HandoffRecoveryHexSync(value: string): string {
	return Array.from(
		sha256Digest(new TextEncoder().encode(value)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function hashHandoffRecoveryDispatchReceipt(
	receipt: Readonly<Record<string, string | number | boolean | null>>,
): Promise<string> {
	return sha256HandoffRecoveryHex(canonicalHandoffRecoveryJson(receipt));
}

export async function createStoredHandoffRecoveryRecord(
	scope: HandoffRecoveryScope,
	intent: HandoffInputIntent,
	storedAt: number,
): Promise<ActiveHandoffRecoveryRecord> {
	assertHandoffRecoveryScope(scope);
	assertSafeTimestamp(storedAt, "storedAt");
	assertIntentMetadata(intent);

	const startContent = intent.startDocument.toString();
	const appliedContent = intent.changes.apply(intent.startDocument).toString();
	if (appliedContent !== intent.afterContent) {
		throw new Error("Captured ChangeSet does not recreate the successor");
	}
	const [startContentHash, afterContentHash] = await Promise.all([
		sha256HandoffRecoveryHex(startContent),
		sha256HandoffRecoveryHex(intent.afterContent),
	]);
	if (startContentHash !== intent.startContentHash) {
		throw new Error("Captured start hash mismatch");
	}
	if (afterContentHash !== intent.afterContentHash) {
		throw new Error("Captured successor hash mismatch");
	}

	const serializedChanges = canonicalHandoffRecoveryJson(intent.changes.toJSON());
	const serializedSelectionBefore = canonicalHandoffRecoveryJson(
		intent.selectionBefore.toJSON(),
	);
	const serializedSelectionAfter = canonicalHandoffRecoveryJson(
		intent.selectionAfter.toJSON(),
	);
	ChangeSet.fromJSON(JSON.parse(serializedChanges));
	const selectionBefore = EditorSelection.fromJSON(JSON.parse(serializedSelectionBefore));
	const selectionAfter = EditorSelection.fromJSON(JSON.parse(serializedSelectionAfter));
	assertSelectionWithinDocument(selectionBefore, startContent.length, "selectionBefore");
	assertSelectionWithinDocument(selectionAfter, intent.afterContent.length, "selectionAfter");

	const body = {
		startContent,
		afterContent: intent.afterContent,
		serializedChanges,
		serializedSelectionBefore,
		serializedSelectionAfter,
		eventProof: {
			proofSchemaVersion: HANDOFF_RECOVERY_PROOF_SCHEMA_VERSION,
			canonicalEncodingVersion: HANDOFF_RECOVERY_CANONICAL_ENCODING_VERSION,
			sessionId: intent.sessionId,
			leafId: intent.leafId,
			handoffGeneration: intent.handoffGeneration,
			bindingEpoch: intent.bindingEpoch,
			inputEpoch: intent.inputEpoch,
			switchIntentSeq: intent.switchIntentSeq,
			inputStartSeq: intent.inputStartSeq,
			inputStartedUnderSwitchSeq: intent.inputStartedUnderSwitchSeq,
			compositionEpoch: intent.compositionEpoch,
			selectionEpoch: intent.selectionEpoch,
		},
	};
	const intentEnvelopeHash = await sha256HandoffRecoveryHex(
		canonicalHandoffRecoveryJson({
			scope,
			intentId: intent.intentId,
			fromPath: intent.fromPath,
			targetPath: intent.targetPath,
			originKind: intent.originKind,
			sequenceBegan: intent.sequenceBegan,
			startContentHash,
			afterContentHash,
			body,
			capturedAt: intent.capturedAt,
		}),
	);

	const withoutChecksum = {
		recordId: buildHandoffRecoveryRecordId(scope, intent.intentId),
		intentId: intent.intentId,
		intentEnvelopeHash,
		scope: { ...scope },
		fromPath: intent.fromPath,
		targetPath: intent.targetPath,
		originKind: intent.originKind,
		sequenceBegan: intent.sequenceBegan,
		startContentHash,
		afterContentHash,
		body,
		applyWitness: null,
		capturedAt: intent.capturedAt,
		storedAt,
		status: "stored" as const,
	};
	return {
		...withoutChecksum,
		checksum: await sha256HandoffRecoveryHex(
			canonicalHandoffRecoveryJson(withoutChecksum),
		),
	};
}

export function isActiveHandoffRecoveryRecord(
	value: HandoffRecoveryRecord,
): value is ActiveHandoffRecoveryRecord {
	return value.status === "stored"
		|| value.status === "replay-pending"
		|| value.status === "replayed-awaiting-settlement"
		|| value.status === "needs-review";
}

export function isTerminalHandoffRecoveryReceipt(
	value: HandoffRecoveryRecord,
): value is TerminalHandoffRecoveryReceipt {
	return value.status === "resolved" || value.status === "discarded";
}

export async function validateHandoffRecoveryRecord(
	value: unknown,
): Promise<HandoffRecoveryRecord> {
	assertPlainRecord(value, "Recovery record");
	const status = value.status;
	if (
		status === "stored"
		|| status === "replay-pending"
		|| status === "replayed-awaiting-settlement"
		|| status === "needs-review"
	) {
		await validateActiveRecord(value, status);
		return value as unknown as ActiveHandoffRecoveryRecord;
	}
	if (status === "resolved" || status === "discarded") {
		await validateTerminalReceipt(value, status);
		return value as unknown as TerminalHandoffRecoveryReceipt;
	}
	throw new Error("Recovery record status is invalid");
}

async function validateActiveRecord(
	value: Record<string, unknown>,
	status: ActiveHandoffRecoveryRecord["status"],
): Promise<void> {
	assertExactKeys(value, [
		"recordId",
		"intentId",
		"intentEnvelopeHash",
		"scope",
		"fromPath",
		"targetPath",
		"originKind",
		"sequenceBegan",
		"startContentHash",
		"afterContentHash",
		"body",
		"applyWitness",
		"checksum",
		"capturedAt",
		"storedAt",
		"status",
	], "active Recovery record");

	assertHandoffRecoveryScope(value.scope);
	assertNonEmptyString(value.recordId, "recordId");
	assertNonEmptyString(value.intentId, "intentId");
	if (value.recordId !== buildHandoffRecoveryRecordId(value.scope, value.intentId)) {
		throw new Error("recordId does not match its Recovery scope and intentId");
	}
	assertSha256Hex(value.intentEnvelopeHash, "intentEnvelopeHash");
	assertNullableBoundedString(value.fromPath, "fromPath");
	assertNonEmptyString(value.targetPath, "targetPath");
	assertEnum(value.originKind, ["user", "ime", "editor-api"], "originKind");
	assertEnum(
		value.sequenceBegan,
		["before-handoff", "after-target-selected"],
		"sequenceBegan",
	);
	assertSha256Hex(value.startContentHash, "startContentHash");
	assertSha256Hex(value.afterContentHash, "afterContentHash");
	assertSafeTimestamp(value.capturedAt, "capturedAt");
	assertSafeTimestamp(value.storedAt, "storedAt");
	assertSha256Hex(value.checksum, "checksum");

	const body = await validateActiveBody(
		value.body,
		value.startContentHash,
		value.afterContentHash,
	);
	validateEventSequence(
		body.eventProof,
		value.sequenceBegan,
	);

	if (value.applyWitness !== null) {
		await validateApplyWitness(value.applyWitness);
	}
	if (status === "stored" && value.applyWitness !== null) {
		throw new Error("stored Recovery records cannot carry an apply witness");
	}
	if (status === "replay-pending") {
		if (value.applyWitness === null) {
			throw new Error("replay-pending Recovery records require a witness");
		}
		if ((value.applyWitness as Record<string, unknown>).dispatchReceiptHash !== null) {
			throw new Error("replay-pending witness cannot carry a dispatch receipt");
		}
	}
	if (status === "replayed-awaiting-settlement") {
		if (value.applyWitness === null) {
			throw new Error("replayed-awaiting-settlement requires a witness");
		}
		assertSha256Hex(
			(value.applyWitness as Record<string, unknown>).dispatchReceiptHash,
			"dispatchReceiptHash",
		);
	}

	const expectedEnvelopeHash = await sha256HandoffRecoveryHex(
		canonicalHandoffRecoveryJson({
			scope: value.scope,
			intentId: value.intentId,
			fromPath: value.fromPath,
			targetPath: value.targetPath,
			originKind: value.originKind,
			sequenceBegan: value.sequenceBegan,
			startContentHash: value.startContentHash,
			afterContentHash: value.afterContentHash,
			body: value.body,
			capturedAt: value.capturedAt,
		}),
	);
	if (value.intentEnvelopeHash !== expectedEnvelopeHash) {
		throw new Error("Recovery intent envelope hash mismatch");
	}
	await assertRecordChecksum(value);
}

async function validateActiveBody(
	value: unknown,
	startContentHash: string,
	afterContentHash: string,
): Promise<ActiveHandoffRecoveryRecord["body"]> {
	assertPlainRecord(value, "Recovery body");
	assertExactKeys(value, [
		"startContent",
		"afterContent",
		"serializedChanges",
		"serializedSelectionBefore",
		"serializedSelectionAfter",
		"eventProof",
	], "Recovery body");
	assertBodyString(value.startContent, "startContent");
	assertBodyString(value.afterContent, "afterContent");
	assertBodyString(value.serializedChanges, "serializedChanges");
	assertBodyString(value.serializedSelectionBefore, "serializedSelectionBefore");
	assertBodyString(value.serializedSelectionAfter, "serializedSelectionAfter");

	const changesJson = parseCanonicalJson(value.serializedChanges, "serializedChanges");
	const selectionBeforeJson = parseCanonicalJson(
		value.serializedSelectionBefore,
		"serializedSelectionBefore",
	);
	const selectionAfterJson = parseCanonicalJson(
		value.serializedSelectionAfter,
		"serializedSelectionAfter",
	);
	let changes: ChangeSet;
	let selectionBefore: EditorSelection;
	let selectionAfter: EditorSelection;
	try {
		changes = ChangeSet.fromJSON(changesJson);
		selectionBefore = EditorSelection.fromJSON(selectionBeforeJson);
		selectionAfter = EditorSelection.fromJSON(selectionAfterJson);
	} catch {
		throw new Error("Recovery changes or selection encoding is invalid");
	}
	const startDocument = textFromString(value.startContent);
	let appliedContent: string;
	try {
		appliedContent = changes.apply(startDocument).toString();
	} catch {
		throw new Error("Recovery ChangeSet does not match its start document");
	}
	if (appliedContent !== value.afterContent) {
		throw new Error("Recovery ChangeSet does not recreate the successor");
	}
	assertSelectionWithinDocument(
		selectionBefore,
		value.startContent.length,
		"selectionBefore",
	);
	assertSelectionWithinDocument(
		selectionAfter,
		value.afterContent.length,
		"selectionAfter",
	);
	const [verifiedStartHash, verifiedAfterHash] = await Promise.all([
		sha256HandoffRecoveryHex(value.startContent),
		sha256HandoffRecoveryHex(value.afterContent),
	]);
	if (verifiedStartHash !== startContentHash) {
		throw new Error("Recovery startContentHash mismatch");
	}
	if (verifiedAfterHash !== afterContentHash) {
		throw new Error("Recovery afterContentHash mismatch");
	}
	const eventProof = validateEventProof(value.eventProof);
	return {
		startContent: value.startContent,
		afterContent: value.afterContent,
		serializedChanges: value.serializedChanges,
		serializedSelectionBefore: value.serializedSelectionBefore,
		serializedSelectionAfter: value.serializedSelectionAfter,
		eventProof,
	};
}

function validateEventProof(
	value: unknown,
): ActiveHandoffRecoveryRecord["body"]["eventProof"] {
	assertPlainRecord(value, "Recovery event proof");
	assertExactKeys(value, [
		"proofSchemaVersion",
		"canonicalEncodingVersion",
		"sessionId",
		"leafId",
		"handoffGeneration",
		"bindingEpoch",
		"inputEpoch",
		"switchIntentSeq",
		"inputStartSeq",
		"inputStartedUnderSwitchSeq",
		"compositionEpoch",
		"selectionEpoch",
	], "Recovery event proof");
	if (value.proofSchemaVersion !== HANDOFF_RECOVERY_PROOF_SCHEMA_VERSION) {
		throw new Error("proofSchemaVersion is incompatible");
	}
	if (
		value.canonicalEncodingVersion
		!== HANDOFF_RECOVERY_CANONICAL_ENCODING_VERSION
	) {
		throw new Error("canonicalEncodingVersion is incompatible");
	}
	assertNonEmptyString(value.sessionId, "sessionId");
	assertNonEmptyString(value.leafId, "leafId");
	assertNonNegativeSafeInteger(value.handoffGeneration, "handoffGeneration");
	assertNonNegativeSafeInteger(value.bindingEpoch, "bindingEpoch");
	assertNonNegativeSafeInteger(value.inputEpoch, "inputEpoch");
	assertNonNegativeSafeInteger(value.switchIntentSeq, "switchIntentSeq");
	assertNonNegativeSafeInteger(value.inputStartSeq, "inputStartSeq");
	assertNullableNonNegativeSafeInteger(
		value.inputStartedUnderSwitchSeq,
		"inputStartedUnderSwitchSeq",
	);
	assertNullableNonNegativeSafeInteger(value.compositionEpoch, "compositionEpoch");
	assertNonNegativeSafeInteger(value.selectionEpoch, "selectionEpoch");
	return value as unknown as ActiveHandoffRecoveryRecord["body"]["eventProof"];
}

function validateEventSequence(
	proof: ActiveHandoffRecoveryRecord["body"]["eventProof"],
	sequenceBegan: ActiveHandoffRecoveryRecord["sequenceBegan"],
): void {
	const isPostSwitch = proof.inputStartSeq > proof.switchIntentSeq
		&& proof.inputStartedUnderSwitchSeq === proof.switchIntentSeq;
	if (sequenceBegan === "after-target-selected" && !isPostSwitch) {
		throw new Error("Recovery event proof does not prove post-switch input");
	}
	if (sequenceBegan === "before-handoff" && isPostSwitch) {
		throw new Error("Recovery event proof contradicts before-handoff lineage");
	}
}

async function validateApplyWitness(value: unknown): Promise<void> {
	assertPlainRecord(value, "Recovery apply witness");
	assertExactKeys(value, [
		"planId",
		"kind",
		"switchIntentSeq",
		"hostLoadTokenId",
		"targetFileId",
		"targetYtextIdentity",
		"targetMutationEpochAtPlan",
		"nativeHistoryEpoch",
		"targetSelectionEpoch",
		"targetScrollEpoch",
		"plannedStartHash",
		"plannedResultContent",
		"plannedResultHash",
		"serializedMappedSelection",
		"dispatchReceiptHash",
	], "Recovery apply witness");
	assertNonEmptyString(value.planId, "planId");
	assertEnum(value.kind, ["exact-replay", "strict-nonoverlap-rebase"], "witness kind");
	assertNonNegativeSafeInteger(value.switchIntentSeq, "switchIntentSeq");
	assertNonEmptyString(value.hostLoadTokenId, "hostLoadTokenId");
	assertNonEmptyString(value.targetFileId, "targetFileId");
	assertNonEmptyString(value.targetYtextIdentity, "targetYtextIdentity");
	assertNonNegativeSafeInteger(value.targetMutationEpochAtPlan, "targetMutationEpochAtPlan");
	assertNonNegativeSafeInteger(value.nativeHistoryEpoch, "nativeHistoryEpoch");
	assertNonNegativeSafeInteger(value.targetSelectionEpoch, "targetSelectionEpoch");
	assertNonNegativeSafeInteger(value.targetScrollEpoch, "targetScrollEpoch");
	assertSha256Hex(value.plannedStartHash, "plannedStartHash");
	assertBodyString(value.plannedResultContent, "plannedResultContent");
	assertSha256Hex(value.plannedResultHash, "plannedResultHash");
	assertBodyString(value.serializedMappedSelection, "serializedMappedSelection");
	if (value.dispatchReceiptHash !== null) {
		assertSha256Hex(value.dispatchReceiptHash, "dispatchReceiptHash");
	}
	if (
		await sha256HandoffRecoveryHex(value.plannedResultContent)
		!== value.plannedResultHash
	) {
		throw new Error("plannedResultHash mismatch");
	}
	const selectionJson = parseCanonicalJson(
		value.serializedMappedSelection,
		"serializedMappedSelection",
	);
	let selection: EditorSelection;
	try {
		selection = EditorSelection.fromJSON(selectionJson);
	} catch {
		throw new Error("serializedMappedSelection is invalid");
	}
	assertSelectionWithinDocument(
		selection,
		value.plannedResultContent.length,
		"mappedSelection",
	);
}

async function validateTerminalReceipt(
	value: Record<string, unknown>,
	status: TerminalHandoffRecoveryReceipt["status"],
): Promise<void> {
	assertExactKeys(value, [
		"recordId",
		"intentId",
		"intentEnvelopeHash",
		"scope",
		"fromPath",
		"targetPath",
		"startContentHash",
		"afterContentHash",
		"checksum",
		"finalizedAt",
		"status",
		"disposition",
	], "terminal Recovery receipt");
	assertHandoffRecoveryScope(value.scope);
	assertNonEmptyString(value.recordId, "recordId");
	assertNonEmptyString(value.intentId, "intentId");
	if (value.recordId !== buildHandoffRecoveryRecordId(value.scope, value.intentId)) {
		throw new Error("recordId does not match its Recovery scope and intentId");
	}
	assertSha256Hex(value.intentEnvelopeHash, "intentEnvelopeHash");
	assertNullableBoundedString(value.fromPath, "fromPath");
	assertNonEmptyString(value.targetPath, "targetPath");
	assertSha256Hex(value.startContentHash, "startContentHash");
	assertSha256Hex(value.afterContentHash, "afterContentHash");
	assertSha256Hex(value.checksum, "checksum");
	assertSafeTimestamp(value.finalizedAt, "finalizedAt");
	if (status === "resolved") {
		assertEnum(
			value.disposition,
			["settled-replay", "manual-resolution"],
			"resolved disposition",
		);
	} else if (value.disposition !== "discard") {
		throw new Error("discarded Recovery receipt requires discard disposition");
	}
	await assertRecordChecksum(value);
}

async function assertRecordChecksum(value: Record<string, unknown>): Promise<void> {
	const { checksum, ...withoutChecksum } = value;
	const expected = await sha256HandoffRecoveryHex(
		canonicalHandoffRecoveryJson(withoutChecksum),
	);
	if (checksum !== expected) {
		throw new Error("Recovery record checksum mismatch");
	}
}

function parseCanonicalJson(value: string, name: string): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${name} is not valid JSON`);
	}
	if (canonicalHandoffRecoveryJson(parsed) !== value) {
		throw new Error(`${name} is not canonical JSON`);
	}
	return parsed;
}

function textFromString(value: string): Text {
	return Text.of(value.split("\n"));
}

function assertSelectionWithinDocument(
	selection: EditorSelection,
	documentLength: number,
	name: string,
): void {
	for (const range of selection.ranges) {
		if (
			range.anchor < 0
			|| range.head < 0
			|| range.anchor > documentLength
			|| range.head > documentLength
		) {
			throw new Error(`${name} range is outside its document`);
		}
	}
}

function assertBodyString(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string") {
		throw new Error(`${name} must be a string`);
	}
}

function assertNullableBoundedString(
	value: unknown,
	name: string,
): asserts value is string | null {
	if (value !== null) assertNonEmptyString(value, name);
}

function assertEnum<const T extends string>(
	value: unknown,
	values: readonly T[],
	name: string,
): asserts value is T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${name} is invalid`);
	}
}

function assertIntentMetadata(intent: HandoffInputIntent): void {
	assertNonEmptyString(intent.intentId, "intentId");
	assertNonEmptyString(intent.sessionId, "sessionId");
	assertNonEmptyString(intent.leafId, "leafId");
	if (intent.fromPath !== null) assertNonEmptyString(intent.fromPath, "fromPath");
	assertNonEmptyString(intent.targetPath, "targetPath");
	if (intent.targetFile.path !== intent.targetPath) {
		throw new Error("targetFile path does not match targetPath");
	}
	assertNonNegativeSafeInteger(intent.handoffGeneration, "handoffGeneration");
	assertNonNegativeSafeInteger(intent.bindingEpoch, "bindingEpoch");
	assertNonNegativeSafeInteger(intent.inputEpoch, "inputEpoch");
	assertNonNegativeSafeInteger(intent.switchIntentSeq, "switchIntentSeq");
	assertNonNegativeSafeInteger(intent.inputStartSeq, "inputStartSeq");
	assertNullableNonNegativeSafeInteger(
		intent.inputStartedUnderSwitchSeq,
		"inputStartedUnderSwitchSeq",
	);
	assertNullableNonNegativeSafeInteger(intent.compositionEpoch, "compositionEpoch");
	assertNonNegativeSafeInteger(intent.selectionEpoch, "selectionEpoch");
	assertSafeTimestamp(intent.capturedAt, "capturedAt");
	assertSha256Hex(intent.startContentHash, "startContentHash");
	assertSha256Hex(intent.afterContentHash, "afterContentHash");
	if (!(["before-handoff", "after-target-selected"] as const).includes(intent.sequenceBegan)) {
		throw new Error("sequenceBegan is invalid");
	}
	if (!(["user", "ime", "editor-api"] as const).includes(intent.originKind)) {
		throw new Error("originKind is invalid");
	}
	validateEventSequence({
		proofSchemaVersion: HANDOFF_RECOVERY_PROOF_SCHEMA_VERSION,
		canonicalEncodingVersion: HANDOFF_RECOVERY_CANONICAL_ENCODING_VERSION,
		sessionId: intent.sessionId,
		leafId: intent.leafId,
		handoffGeneration: intent.handoffGeneration,
		bindingEpoch: intent.bindingEpoch,
		inputEpoch: intent.inputEpoch,
		switchIntentSeq: intent.switchIntentSeq,
		inputStartSeq: intent.inputStartSeq,
		inputStartedUnderSwitchSeq: intent.inputStartedUnderSwitchSeq,
		compositionEpoch: intent.compositionEpoch,
		selectionEpoch: intent.selectionEpoch,
	}, intent.sequenceBegan);
}

function assertNonNegativeSafeInteger(value: unknown, name: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${name} must be a non-negative safe integer`);
	}
}

function assertNullableNonNegativeSafeInteger(
	value: unknown,
	name: string,
): asserts value is number | null {
	if (value !== null) assertNonNegativeSafeInteger(value, name);
}

function assertPlainRecord(
	value: unknown,
	name: string,
): asserts value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${name} must be a plain object`);
	}
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${name} must be a plain object`);
	}
}

function assertExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	name: string,
): void {
	const actual = Object.keys(value).sort();
	const required = [...expected].sort();
	if (
		actual.length !== required.length
		|| actual.some((key, index) => key !== required[index])
	) {
		throw new Error(`${name} has unknown or missing fields`);
	}
}
