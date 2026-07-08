import {
	decideClosedFileConflict,
	type MissingBaselineWinnerPolicy,
} from "../../sync/closedFileConflict";

type OpenBoundMissingBaselinePolicy =
	| MissingBaselineWinnerPolicy
	| "open-bound-visible-authority";

export type OpenBoundEditorAuthority =
	| { kind: "single"; relation: "disk" | "crdt" | "both" | "distinct" }
	| { kind: "multiple" }
	| { kind: "read-failed" }
	| { kind: "none" };

export interface OpenBoundFileReconcileInput {
	readonly diskHash: string;
	readonly crdtHash: string;
	readonly baselineHash: string | null;
	readonly editorAuthority: OpenBoundEditorAuthority;
	readonly hasRecentEditorActivity: boolean;
	readonly diskMtime?: number;
	readonly lastDiskIndexPersistedAt?: number;
}

export type OpenBoundFileReconcileAction =
	| { kind: "no-op"; reason: "disk-equals-crdt" }
	| { kind: "defer-recent-editor"; reason: "recent-editor-activity" }
	| {
		kind: "import-disk-to-crdt";
		reason: "crdt-at-baseline" | "both-changed" | "missing-baseline";
		preserveCrdt?: true;
		missingBaselinePolicy?: OpenBoundMissingBaselinePolicy;
	}
	| {
		kind: "apply-crdt-to-disk";
		reason: "disk-at-baseline" | "both-changed" | "missing-baseline";
		preserveDisk?: true;
		missingBaselinePolicy?: OpenBoundMissingBaselinePolicy;
	}
	| {
		kind: "editor-wins-preserve";
		reason: "both-changed" | "missing-baseline";
		preserveCrdt?: true;
		preserveDisk?: true;
		missingBaselinePolicy?: OpenBoundMissingBaselinePolicy;
	}
	| {
		kind: "ambiguous-conflict";
		reason: "multiple-editor-authorities" | "editor-read-failed" | "missing-editor-authority";
	};

export function planOpenBoundFileReconcile(
	input: OpenBoundFileReconcileInput,
): OpenBoundFileReconcileAction {
	const {
		diskHash,
		crdtHash,
		baselineHash,
		editorAuthority,
		hasRecentEditorActivity,
		diskMtime,
		lastDiskIndexPersistedAt,
	} = input;

	if (diskHash === crdtHash) {
		return { kind: "no-op", reason: "disk-equals-crdt" };
	}

	if (hasRecentEditorActivity) {
		return { kind: "defer-recent-editor", reason: "recent-editor-activity" };
	}

	if (editorAuthority.kind === "multiple") {
		return { kind: "ambiguous-conflict", reason: "multiple-editor-authorities" };
	}
	if (editorAuthority.kind === "read-failed") {
		return { kind: "ambiguous-conflict", reason: "editor-read-failed" };
	}
	if (editorAuthority.kind === "none") {
		return { kind: "ambiguous-conflict", reason: "missing-editor-authority" };
	}

	if (editorAuthority.relation === "distinct") {
		return {
			kind: "editor-wins-preserve",
			reason: baselineHash === null ? "missing-baseline" : "both-changed",
			preserveCrdt: true,
			preserveDisk: true,
		};
	}

	if (baselineHash === null) {
		const decision = decideClosedFileConflict({
			baselineHash,
			diskHash,
			crdtHash,
			diskMtime,
			lastDiskIndexPersistedAt,
		});
		// Open/bound files have a visible editor authority. Without this
		// override, missing-baseline autosave/external-edit streams can demote
		// every growing disk version into a conflict artifact.
		return {
			kind: "import-disk-to-crdt",
			reason: "missing-baseline",
			preserveCrdt: true,
			missingBaselinePolicy: decision._missingBaselinePolicy === "disk-mtime-after-last-index-save"
				? decision._missingBaselinePolicy
				: "open-bound-visible-authority",
		};
	}

	if (
		baselineHash !== null &&
		diskHash !== baselineHash &&
		crdtHash !== baselineHash
	) {
		if (editorAuthority.relation === "crdt" || editorAuthority.relation === "both") {
			return {
				kind: "editor-wins-preserve",
				reason: "both-changed",
				preserveDisk: true,
			};
		}
		return {
			kind: "import-disk-to-crdt",
			reason: "both-changed",
			preserveCrdt: true,
		};
	}

	const decision = decideClosedFileConflict({
		baselineHash,
		diskHash,
		crdtHash,
		diskMtime,
		lastDiskIndexPersistedAt,
	});

	switch (decision.kind) {
		case "no-op":
			return { kind: "no-op", reason: "disk-equals-crdt" };
		case "import-disk-to-crdt":
			return { kind: "import-disk-to-crdt", reason: decision.reason };
		case "apply-remote-to-disk":
			return { kind: "apply-crdt-to-disk", reason: decision.reason };
		case "preserve-conflict":
			if (decision.winner === "disk") {
				return {
					kind: "import-disk-to-crdt",
					reason: decision.reason,
					preserveCrdt: decision.preserveCrdt,
					missingBaselinePolicy: decision._missingBaselinePolicy,
				};
			}
			if (editorAuthority.relation === "crdt" || editorAuthority.relation === "both") {
				return {
					kind: "editor-wins-preserve",
					reason: decision.reason,
					preserveDisk: true,
					missingBaselinePolicy: decision._missingBaselinePolicy,
				};
			}
			return {
				kind: "apply-crdt-to-disk",
				reason: decision.reason,
				preserveDisk: decision.preserveDisk,
				missingBaselinePolicy: decision._missingBaselinePolicy,
			};
	}
}
