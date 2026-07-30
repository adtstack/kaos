import { ChangeSet, EditorSelection, Text } from "@codemirror/state";
import { TFile } from "obsidian";
import {
	createStoredHandoffRecoveryRecord,
	sha256HandoffRecoveryHex,
	type ActiveHandoffRecoveryRecord,
	type HandoffRecoveryScope,
} from "../../src/sync/handoffRecoveryStore";
import type { HandoffInputIntent } from "../../src/sync/editorHandoffState";

export class ReplayFixtureFile extends TFile {
	constructor(path: string) {
		super();
		this.path = path;
		this.name = path.split("/").at(-1) ?? path;
		this.basename = this.name.replace(/\.md$/u, "");
		this.extension = "md";
	}
}

export type StoredReplayFixtureOptions = Readonly<{
	startDocument?: Text;
	changes?: ChangeSet;
	selectionBefore?: EditorSelection;
	selectionAfter?: EditorSelection;
	intentOverrides?: Partial<HandoffInputIntent>;
}>;

export async function makeStoredReplayFixture(
	options: StoredReplayFixtureOptions = {},
): Promise<{
	intent: HandoffInputIntent;
	record: ActiveHandoffRecoveryRecord & Readonly<{ status: "stored" }>;
}> {
	const startDocument = options.startDocument ?? Text.of(["base"]);
	const changes = options.changes
		?? ChangeSet.of(
			[{ from: startDocument.length, insert: "!" }],
			startDocument.length,
		);
	const afterContent = changes.apply(startDocument).toString();
	const targetFile = new ReplayFixtureFile("B.md");
	const defaultSelectionBefore = EditorSelection.single(startDocument.length);
	const defaultSelectionAfter = defaultSelectionBefore.map(changes);
	const intent: HandoffInputIntent = {
		intentId: "intent-a-b-1",
		sessionId: "session-1",
		leafId: "leaf-1",
		handoffGeneration: 7,
		fromPath: "A.md",
		fromFileId: "file-a",
		targetPath: "B.md",
		targetFile,
		bindingEpoch: 11,
		inputEpoch: 3,
		switchIntentSeq: 19,
		inputStartSeq: 20,
		inputStartedUnderSwitchSeq: 19,
		compositionEpoch: null,
		selectionEpoch: 5,
		sequenceBegan: "after-target-selected",
		startDocument,
		startContentHash: await sha256HandoffRecoveryHex(startDocument.toString()),
		changes,
		afterContent,
		afterContentHash: await sha256HandoffRecoveryHex(afterContent),
		selectionBefore: options.selectionBefore ?? defaultSelectionBefore,
		selectionAfter: options.selectionAfter ?? defaultSelectionAfter,
		originKind: "user",
		userEvent: "input",
		capturedAt: 1_800_000_000_000,
		...options.intentOverrides,
	};
	const scope: HandoffRecoveryScope = {
		schemaVersion: 1,
		vaultId: "vault-a",
		localDeviceId: "local-device-a",
	};
	const record = await createStoredHandoffRecoveryRecord(
		scope,
		intent,
		1_800_000_000_100,
	);
	return {
		intent,
		record: record as ActiveHandoffRecoveryRecord & Readonly<{ status: "stored" }>,
	};
}

export async function makeFreshStoredReplayFixture(
	overrides: Partial<HandoffInputIntent> = {},
): Promise<{
	intent: HandoffInputIntent;
	record: ActiveHandoffRecoveryRecord & Readonly<{ status: "stored" }>;
}> {
	return makeStoredReplayFixture({ intentOverrides: overrides });
}
