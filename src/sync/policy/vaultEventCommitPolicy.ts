/**
 * Final path-namespace fences for delayed Obsidian vault events.
 *
 * Event payloads describe the object that changed, but the path may already
 * belong to a newer object when the callback runs. These policies deliberately
 * inspect the live path namespace at commit time so an old delete/rename event
 * cannot tombstone or move a same-path replacement.
 */

export type VaultPathOccupantKind = "missing" | "file" | "non-file";

export type MarkdownDeleteCommitAction =
	| { kind: "commit-delete" }
	| { kind: "admit-replacement" }
	| { kind: "quarantine-path-collision" };

export function planMarkdownDeleteCommit(
	occupant: VaultPathOccupantKind,
): MarkdownDeleteCommitAction {
	switch (occupant) {
		case "missing":
			return { kind: "commit-delete" };
		case "file":
			return { kind: "admit-replacement" };
		case "non-file":
			return { kind: "quarantine-path-collision" };
	}
}

/** Blob paths use the same namespace fence, but dispatch a fresh file winner
 * through BlobSync instead of the Markdown dirty-ingest lane. */
export const planBlobDeleteCommit = planMarkdownDeleteCommit;

export type RenameEventCommitAction =
	| { kind: "commit-rename" }
	| {
		kind: "quarantine-path-collision";
		reason: "target-replaced" | "old-path-reoccupied" | "both-paths-changed";
	};

export function planRenameEventCommit(input: {
	targetMatchesEventFile: boolean;
	oldPathIsMissing: boolean;
}): RenameEventCommitAction {
	if (input.targetMatchesEventFile && input.oldPathIsMissing) {
		return { kind: "commit-rename" };
	}
	if (!input.targetMatchesEventFile && !input.oldPathIsMissing) {
		return { kind: "quarantine-path-collision", reason: "both-paths-changed" };
	}
	return {
		kind: "quarantine-path-collision",
		reason: input.targetMatchesEventFile ? "old-path-reoccupied" : "target-replaced",
	};
}
