export const EXACT_HANDOFF_REPLAY_SCENARIO_ID =
	"s13d-editor-handoff-exact-replay" as const;

export type ExactHandoffReplayExternalPhase =
	| "exact-ascii-selection-scroll"
	| "native-undo"
	| "native-redo"
	| "exact-completed-ime"
	| "manual-switch-spanning-ime"
	| "manual-different-base"
	| "exact-missing-ytext"
	| "exact-same-content-held-load"
	| "supersede-b-with-c";

export type ExactHandoffReplayPaths = Readonly<{
	a: string;
	b: string;
	c: string | null;
}>;

export const EXACT_HANDOFF_REPLAY_PHASES = Object.freeze([
	"exact-ascii-selection-scroll",
	"native-undo",
	"native-redo",
	"exact-completed-ime",
	"manual-switch-spanning-ime",
	"manual-different-base",
	"exact-missing-ytext",
	"exact-same-content-held-load",
	"supersede-b-with-c",
] as const satisfies readonly ExactHandoffReplayExternalPhase[]);

export const EXACT_HANDOFF_REPLAY_PATHS = Object.freeze({
	"exact-ascii-selection-scroll": Object.freeze({
		a: "QA-exact-replay-ascii-A.md",
		b: "QA-exact-replay-ascii-B.md",
		c: null,
	}),
	"native-undo": Object.freeze({
		a: "QA-exact-replay-ascii-A.md",
		b: "QA-exact-replay-ascii-B.md",
		c: null,
	}),
	"native-redo": Object.freeze({
		a: "QA-exact-replay-ascii-A.md",
		b: "QA-exact-replay-ascii-B.md",
		c: null,
	}),
	"exact-completed-ime": Object.freeze({
		a: "QA-exact-replay-ime-A.md",
		b: "QA-exact-replay-ime-B.md",
		c: null,
	}),
	"manual-switch-spanning-ime": Object.freeze({
		a: "QA-exact-replay-spanning-ime-A.md",
		b: "QA-exact-replay-spanning-ime-B.md",
		c: null,
	}),
	"manual-different-base": Object.freeze({
		a: "QA-exact-replay-different-base-A.md",
		b: "QA-exact-replay-different-base-B.md",
		c: null,
	}),
	"exact-missing-ytext": Object.freeze({
		a: "QA-exact-replay-missing-ytext-A.md",
		b: "QA-exact-replay-missing-ytext-B.md",
		c: null,
	}),
	"exact-same-content-held-load": Object.freeze({
		a: "QA-exact-replay-held-A.md",
		b: "QA-exact-replay-held-B.md",
		c: null,
	}),
	"supersede-b-with-c": Object.freeze({
		a: "QA-exact-replay-supersede-A.md",
		b: "QA-exact-replay-supersede-B.md",
		c: "QA-exact-replay-supersede-C.md",
	}),
} satisfies Readonly<Record<ExactHandoffReplayExternalPhase, ExactHandoffReplayPaths>>);

export const EXACT_HANDOFF_REPLAY_ALL_PATHS = Object.freeze(Array.from(new Set(
	Object.values(EXACT_HANDOFF_REPLAY_PATHS).flatMap(({ a, b, c }) =>
		c === null ? [a, b] : [a, b, c]),
)));
