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
	/**
	 * Strict proof (hash equality with the last successful DiskMirror write)
	 * that the disk change is KAOS's own lagging mirror output. Prevents the
	 * delegated closed-file decisions from letting a mirror race import
	 * stale disk bytes over fresher CRDT content.
	 */
	readonly diskChangeIsSelfMirror?: boolean;
	readonly lastDiskIndexPersistedAt?: number;
	/** Per-file settlement time (DiskIndexEntry.settledAtMs); preferred mtime evidence. */
	readonly lastFileSettledAtMs?: number;
	/**
	 * True when the single visible editor content is byte-identical to the
	 * stored baseline text for `baselineHash`. Such an editor is a provably
	 * stale render of the last settled state (intercepted/delayed host
	 * reload, backgrounded view), not the user's latest intent: with no
	 * recent activity it must not win over disk/CRDT.
	 */
	readonly editorMatchesBaseline?: boolean;
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
		reason: "disk-at-baseline" | "both-changed" | "missing-baseline" | "self-mirror-lag";
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
		diskChangeIsSelfMirror,
		lastDiskIndexPersistedAt,
		lastFileSettledAtMs,
		editorMatchesBaseline,
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
		if (editorMatchesBaseline === true && baselineHash !== null) {
			// Provably stale editor: it renders the settled baseline exactly
			// and shows no recent activity, so it cannot be the user's latest
			// intent. Exclude it from authority and decide disk vs CRDT with
			// the ordinary three-way rule. (Editor-wins here would roll both
			// converged sides back to the older render.)
			const decision = decideClosedFileConflict({
				baselineHash,
				diskHash,
				crdtHash,
				diskChangeIsSelfMirror,
				diskMtime,
				lastDiskIndexPersistedAt,
				lastFileSettledAtMs,
			});
			switch (decision.kind) {
				case "no-op":
					return { kind: "no-op", reason: "disk-equals-crdt" };
				case "apply-remote-to-disk":
					return { kind: "apply-crdt-to-disk", reason: decision.reason };
				case "import-disk-to-crdt":
					return {
						kind: "import-disk-to-crdt",
						reason: decision.reason,
					};
				case "preserve-conflict":
					if (decision.winner === "disk") {
						return {
							kind: "import-disk-to-crdt",
							reason: decision.reason,
							preserveCrdt: decision.preserveCrdt,
						};
					}
					return {
						kind: "apply-crdt-to-disk",
						reason: decision.reason,
						preserveDisk: decision.preserveDisk,
					};
			}
		}
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
			diskChangeIsSelfMirror,
			diskMtime,
			lastDiskIndexPersistedAt,
			lastFileSettledAtMs,
		});
		// A missing baseline cannot prove that the disk copy is newer. If the
		// visible editor still agrees with CRDT, importing a different disk
		// snapshot would visibly roll the note back. Keep the visible side and
		// preserve the disk copy for explicit recovery instead.
		if (editorAuthority.relation === "crdt" || editorAuthority.relation === "both") {
			return {
				kind: "editor-wins-preserve",
				reason: "missing-baseline",
				preserveDisk: true,
				missingBaselinePolicy: "open-bound-visible-authority",
			};
		}

		// The editor itself carries the disk version, so disk remains the only
		// visible authority. Preserve the previous CRDT side before importing.
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
		diskChangeIsSelfMirror,
		diskMtime,
		lastDiskIndexPersistedAt,
		lastFileSettledAtMs,
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
