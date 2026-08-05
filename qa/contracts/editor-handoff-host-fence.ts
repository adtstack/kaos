/**
 * Cross-process contract for the live editor handoff host-fence scenario.
 *
 * The controller runs in Bun/Node and performs the real filesystem write while
 * the scenario runs inside Obsidian. Keep the external revision and its digest
 * here so neither side may infer success from whatever bytes happen to settle.
 */
export const EDITOR_HANDOFF_HOST_FENCES_SCENARIO_ID =
	"s13a-editor-handoff-host-fences" as const;

export const EDITOR_HANDOFF_HOST_FENCE_PATHS = Object.freeze({
	a: "QA-handoff-fences-A.md",
	b: "QA-handoff-fences-B.md",
	c: "QA-handoff-fences-C.md",
});

export const EDITOR_HANDOFF_HELD_EXTERNAL_TARGET_REVISION = Object.freeze({
	content: [
		"# Editor handoff host fences",
		"",
		"external-node-write-while-b-load-is-held",
		"",
	].join("\n"),
	sha256: "eb55ef9d5721a208399e9af40356250b3e90c597dc42630d0d1254a94f321483",
});
