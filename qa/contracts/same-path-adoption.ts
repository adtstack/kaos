export const SAME_PATH_ADOPTION_SCENARIO_ID = "s13e-same-path-adoption" as const;

export type SamePathAdoptionExternalPhase =
	| "clean-merge-during-planning"
	| "native-undo-local"
	| "native-redo-local"
	| "held-save-reload"
	| "overlap-conflict-evidence"
	| "artifact-failure"
	| "artifact-retry"
	| "identical-multi-pane"
	| "distinct-multi-pane"
	| "distinct-multi-pane-observed"
	| "unsupported-host-fallback";

export const SAME_PATH_ADOPTION_PHASES = Object.freeze([
	"clean-merge-during-planning",
	"native-undo-local",
	"native-redo-local",
	"held-save-reload",
	"overlap-conflict-evidence",
	"artifact-failure",
	"artifact-retry",
	"identical-multi-pane",
	"distinct-multi-pane",
	"unsupported-host-fallback",
] as const satisfies readonly SamePathAdoptionExternalPhase[]);

export const SAME_PATH_ADOPTION_PATHS = Object.freeze({
	clean: "QA-same-path-adoption-clean.md",
	saveReload: "QA-same-path-adoption-save-reload.md",
	conflict: "QA-same-path-adoption-conflict.md",
	artifactRetry: "QA-same-path-adoption-artifact-retry.md",
	multiPane: "QA-same-path-adoption-multi-pane.md",
	unsupportedA: "QA-same-path-adoption-unsupported-A.md",
	unsupportedB: "QA-same-path-adoption-unsupported-B.md",
});

export const SAME_PATH_ADOPTION_ALL_PATHS = Object.freeze(
	Object.values(SAME_PATH_ADOPTION_PATHS),
);
