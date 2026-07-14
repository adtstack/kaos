import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

function assert(condition, name) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

function sliceBetween(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	if (start < 0 || end < 0 || end <= start) {
		return null;
	}
	return source.slice(start, end);
}

const workspaceSource = readFileSync(new URL("../src/runtime/editorWorkspaceOrchestrator.ts", import.meta.url), "utf8");
const bindingSource = readFileSync(new URL("../src/sync/editorBinding.ts", import.meta.url), "utf8");

console.log("\n--- Test 1: validateOpenBindings delegates repair to guarded audit ---");
{
	const section = sliceBetween(
		workspaceSource,
		"validateOpenBindings(reason: string): void {",
		"auditBindings(reason: string): number {",
	);
	assert(section !== null, "validateOpenBindings section found");
	assert(section?.includes("editorBindings.auditBindings(`validate:${reason}`)"), "validateOpenBindings delegates to auditBindings");
	assert(!section?.includes("editorBindings.repair("), "validateOpenBindings does not directly call repair");
	assert(!section?.includes("editorBindings.rebind("), "validateOpenBindings does not directly call rebind");
	assert(!section?.includes("editorBindings.heal("), "validateOpenBindings does not call heal");
}

console.log("\n--- Test 2: bind unhealthy path uses repair, not heal ---");
{
	const section = sliceBetween(
		bindingSource,
		"bind(view: MarkdownView, deviceName: string): void {",
		"repair(view: MarkdownView, deviceName: string, reason: string): boolean {",
	);
	assert(section !== null, "bind section found");
	assert(section?.includes("this.deferRepairForRecentEditorActivity("), "bind unhealthy path defers repair during recent editor activity");
	assert(section?.includes("if (this.repair(view, deviceName, `bind-health:${reason}`))"), "bind unhealthy path calls repair");
	assert(!section?.includes("if (this.heal(view, deviceName, `bind-health:${reason}`))"), "bind unhealthy path does not call heal");
}

console.log("\n--- Test 3: maybeHealBinding uses repair/rebind and traces repair-only ---");
{
	const section = sliceBetween(
		bindingSource,
		"private maybeHealBinding(",
		"private scheduleCmResolveRetry(",
	);
	assert(section !== null, "maybeHealBinding section found");
	assert(section?.includes("const repaired = this.repair("), "maybeHealBinding calls repair");
	assert(!section?.includes("const healed = this.heal("), "maybeHealBinding does not call heal");
	assert(section?.includes('? "repair-only"'), "health-restored action reports repair-only");
}

console.log("\n--- Test 4: direct rebind is guarded by recent editor activity ---");
{
	const section = sliceBetween(
		bindingSource,
		"rebind(view: MarkdownView, deviceName: string, reason: string): void {",
		"/**\n\t * Unbind a MarkdownView's editor",
	);
	assert(section !== null, "rebind section found");
	assert(section?.includes("this.deferRepairForRecentEditorActivity("), "rebind defers during recent editor activity");
	assert(section?.indexOf("this.deferRepairForRecentEditorActivity(") < section?.indexOf("this.unbind(view)"), "rebind checks defer before unbind");
}

console.log("\n--- Test 5: bind cm-change path is guarded before unbind ---");
{
	const section = sliceBetween(
		bindingSource,
		"bind(view: MarkdownView, deviceName: string): void {",
		"repair(view: MarkdownView, deviceName: string, reason: string): boolean {",
	);
	assert(section !== null, "bind section found");
	assert(section?.includes("\"bind-target-changed:cm-changed\""), "bind cm-change path has recent activity guard");
	assert(section?.includes("this.pendingReplacementCmToLeafId.set(cm, leafId)"), "deferred bind cm-change tracks the replacement editor");
	assert(section?.indexOf("\"bind-target-changed:cm-changed\"") < section?.indexOf("this.unbind(view)"), "bind cm-change guard runs before unbind");
}

console.log("\n--- Test 6: pending replacement cm updates still map to the binding ---");
{
	const section = sliceBetween(
		bindingSource,
		"private findBindingForCm(cm: EditorView): { leafId: string; binding: EditorBinding } | null {",
		"private findBindingForState(state: EditorState): { leafId: string; binding: EditorBinding } | null {",
	);
	assert(section !== null, "findBindingForCm section found");
	assert(section?.includes("this.pendingReplacementCmToLeafId.get(cm)"), "findBindingForCm checks pending replacement editors");
	assert(section?.includes("this.isPendingReplacementCmForBinding(cm, binding)"), "pending replacement editor must still belong to the binding view");
}

console.log("\n--- Test 7: same-path binding replacement preserves editor activity ---");
{
	const section = sliceBetween(
		bindingSource,
		"private applyBinding(options: {",
		"// Emit editor.repair.applied only for successful repair-action applications.",
	);
	assert(section !== null, "applyBinding section found");
	assert(section?.includes("const carryExistingActivity = existing?.path === filePath"), "applyBinding only carries activity for the same path");
	assert(section?.includes("lastEditorDocChangeAtMs,"), "applyBinding stores the carried document activity timestamp");
}

console.log("\n--- Test 8: applyBinding refuses divergent editor content ---");
{
	const section = sliceBetween(
		bindingSource,
		"private applyBinding(options: {",
		"private canApplyBindingToEditor(input: {",
	);
	const guardSection = sliceBetween(
		bindingSource,
		"private canApplyBindingToEditor(input: {",
		"private log(msg: string): void {",
	);
	assert(section !== null, "applyBinding section found");
	assert(guardSection !== null, "canApplyBindingToEditor section found");
	assert(section?.includes("this.canApplyBindingToEditor({"), "applyBinding checks editor/CRDT content before reconfigure");
	assert(
		(section?.indexOf("this.canApplyBindingToEditor({") ?? Infinity) < (section?.indexOf("new Y.UndoManager") ?? -1),
		"applyBinding guard runs before creating yCollab state",
	);
	assert(
		guardSection?.includes("editorContent === crdtContent"),
		"canApplyBindingToEditor only allows matching editor and CRDT content",
	);
	assert(
		guardSection?.includes('"binding-apply-editor-diverged"'),
		"canApplyBindingToEditor traces divergent apply attempts",
	);
}

console.log("\n--- Test 9: destructive provider patches only shield during recent editor activity ---");
{
	const section = sliceBetween(
		bindingSource,
		"private filterRiskyNonUserPatch(transaction: Transaction):",
		"private createYTextOriginCaptureExtension(",
	);
	assert(section !== null, "filterRiskyNonUserPatch section found");
	assert(
		section?.includes("this.shouldShieldYTextPatch({"),
		"filterRiskyNonUserPatch checks whether incoming content preserves editor content",
	);
	assert(
		!section?.includes("this.planEditorYTextMerge({"),
		"filterRiskyNonUserPatch does not attempt live 3-way auto-merge",
	);
	assert(
		section?.includes("this.hasRecentUserDocumentEdit(binding, RECENT_EDITOR_PATCH_SHIELD_MS)"),
		"filterRiskyNonUserPatch only shields destructive patches during recent editor activity",
	);
	assert(
		(section?.indexOf("this.shouldShieldYTextPatch({") ?? Infinity) <
			(section?.indexOf("this.hasRecentUserDocumentEdit(binding, RECENT_EDITOR_PATCH_SHIELD_MS)") ?? -1),
		"preservation check runs before recent-activity shielding",
	);
}

console.log("\n--- Test 9b: live editor patch filtering has no 3-way merge state ---");
{
	const section = sliceBetween(
		bindingSource,
		"private createYTextOriginCaptureExtension(",
		"private shouldShieldYTextPatch(input: {",
	);
	assert(section !== null, "createYTextOriginCaptureExtension section found");
	assert(
		!bindingSource.includes("mergeTexts3"),
		"EditorBindingManager does not import or call mergeTexts3",
	);
	assert(
		!section?.includes("beforeContentByTransaction"),
		"Y.Text patch capture does not store pre-patch base content for live merge",
	);
	assert(
		!section?.includes("baseContent"),
		"pending Y.Text patch does not include live merge baseContent",
	);
}

console.log("\n--- Test 10: editor-health-heal origin remains manual-only ---");
{
	const healSection = sliceBetween(
		bindingSource,
		"heal(view: MarkdownView, deviceName: string, reason: string): boolean {",
		"rebind(view: MarkdownView, deviceName: string, reason: string): void {",
	);
	assert(healSection !== null, "heal section found");
	// After the origin-constants refactor the call site uses ORIGIN_EDITOR_HEALTH_HEAL
	// (imported from src/sync/origins.ts) instead of the raw string. Check for the
	// constant name rather than the literal.
	assert(
		healSection?.includes("ORIGIN_EDITOR_HEALTH_HEAL"),
		"editor-health-heal origin used via named constant in heal() implementation",
	);
	// Strip the heal section then check that applyDiffToYText is NOT called
	// with ORIGIN_EDITOR_HEALTH_HEAL outside it. The import declaration
	// is allowed to remain (it's not a call site). Use [^\n)]* to stay
	// on the same line and avoid spurious cross-line matches.
	const strippedSource = bindingSource.replace(healSection ?? "", "");
	assert(
		!strippedSource.match(/applyDiffToYText[^\n)]*ORIGIN_EDITOR_HEALTH_HEAL/),
		"ORIGIN_EDITOR_HEALTH_HEAL not passed to applyDiffToYText outside heal()",
	);
}

console.log("\n--- Test 11: binding skips when open editor differs from CRDT ---");
{
	const section = sliceBetween(
		bindingSource,
		"private resolveBindingTarget(",
		"private isHardTombstonedPath(path: string): boolean {",
	);
	assert(section !== null, "resolveBindingTarget section found");
	assert(
		section?.includes('"binding-target-editor-diverged"'),
		"resolveBindingTarget traces divergent open editor",
	);
	assert(
		section?.includes("currentContent !== crdtContent"),
		"resolveBindingTarget compares editor content to CRDT before binding",
	);
	assert(
		section?.includes("return null;"),
		"resolveBindingTarget skips binding instead of overwriting divergent editor content",
	);
}

console.log("\n--- Test 12: excluded Markdown is fenced before editor binding and CRDT creation ---");
{
	const bindSection = sliceBetween(
		bindingSource,
		"bind(view: MarkdownView, deviceName: string): void {",
		"repair(view: MarkdownView, deviceName: string, reason: string): boolean {",
	);
	const targetSection = sliceBetween(
		bindingSource,
		"private resolveBindingTarget(",
		"private canBindPath(",
	);
	const workspaceBindSection = sliceBetween(
		workspaceSource,
		"private bindView(view: MarkdownView): void {",
		"private trackOpenFile(path: string): void {",
	);
	assert(bindSection !== null, "bind section found for excluded-path fence");
	assert(targetSection !== null, "resolveBindingTarget section found for excluded-path fence");
	assert(workspaceBindSection !== null, "workspace bindView section found for excluded-path fence");
	assert(
		(bindSection?.indexOf("this.canBindPath(view, \"bind\")") ?? Infinity) <
			(bindSection?.indexOf("this.getCmView(view)") ?? -1),
		"bind checks syncability before resolving CodeMirror",
	);
	assert(
		(targetSection?.indexOf("this.isMarkdownPathSyncable(file.path)") ?? Infinity) <
			(targetSection?.indexOf("this.vaultSync.ensureFile(") ?? -1),
		"binding target checks syncability before ensureFile",
	);
	assert(
		(workspaceBindSection?.indexOf("this.deps.isMarkdownPathSyncable(path)") ?? Infinity) <
			(workspaceBindSection?.indexOf("bindings?.bind(") ?? -1),
		"workspace skips excluded views before editor binding",
	);
	assert(
		(workspaceBindSection?.indexOf("this.deps.isMarkdownPathSyncable(path)") ?? Infinity) <
			(workspaceBindSection?.indexOf("this.trackOpenFile(path)") ?? -1),
		"workspace skips excluded views before open-file tracking",
	);
}

console.log(`\n${"-".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"-".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
