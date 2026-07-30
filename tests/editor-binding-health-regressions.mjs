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
const editorBindingSource = readFileSync(
	new URL("../src/sync/editorBinding.ts", import.meta.url),
	"utf8",
);
const bindingSource = editorBindingSource;
const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const diskMirrorSource = readFileSync(new URL("../src/sync/diskMirror.ts", import.meta.url), "utf8");
const reconciliationSource = readFileSync(
	new URL("../src/runtime/reconciliationController.ts", import.meta.url),
	"utf8",
);

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
	assert(section?.indexOf("\"bind-target-changed:cm-changed\"") < section?.lastIndexOf("this.unbind(view)"), "bind cm-change guard runs before replacement unbind");
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
		guardSection?.includes("cmContent === crdtContent"),
		"canApplyBindingToEditor only allows matching selected CM and CRDT content",
	);
	assert(
		guardSection?.includes('"binding-apply-editor-diverged"'),
		"canApplyBindingToEditor traces divergent apply attempts",
	);
}

console.log("\n--- Test 9: authority shield is limited to fresh named local repairs ---");
{
	const section = sliceBetween(
		bindingSource,
		"private filterRiskyNonUserPatch(transaction: Transaction):",
		"private createYTextOriginCaptureExtension(",
	);
	const shieldPredicate = sliceBetween(
		bindingSource,
		"private shouldShieldYTextPatch(input: {",
		"private incomingContentPreservesEditorContent(",
	);
	assert(section !== null, "filterRiskyNonUserPatch section found");
	assert(shieldPredicate !== null, "shouldShieldYTextPatch section found");
	assert(
		section?.includes("this.shouldShieldYTextPatch({"),
		"filterRiskyNonUserPatch checks whether incoming content preserves editor content",
	);
	assert(
		section?.includes("Date.now() - pendingPatch.at <= 1000"),
		"filterRiskyNonUserPatch accepts only a fresh captured origin",
	);
	assert(
		shieldPredicate?.includes("!EDITOR_AUTHORITY_SHIELD_ORIGINS.has(input.origin)"),
		"shield predicate rejects provider/object/null/unknown and explicit restore origins",
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

console.log("\n--- Test 9a: remote typing awareness is advisory only ---");
{
	const section = sliceBetween(
		bindingSource,
		"private filterRiskyNonUserPatch(transaction: Transaction):",
		"private createYTextOriginCaptureExtension(",
	);
	const warningSection = sliceBetween(
		bindingSource,
		"private warnConcurrentTyping(",
		"/**\n\t * Get the CM6 EditorView",
	);
	assert(section !== null, "filterRiskyNonUserPatch section found for typing advisory check");
	assert(warningSection !== null, "warnConcurrentTyping section found");
	assert(
		section?.includes("this.warnConcurrentTyping(match.binding.path, remoteTypers)"),
		"active remote typing emits an advisory warning",
	);
	const nonUserBranchIndex = section?.indexOf("const { leafId, binding } = match;") ?? -1;
	const cancelledTransactionIndex = section?.indexOf("return [];") ?? -1;
	assert(
		nonUserBranchIndex >= 0 && cancelledTransactionIndex > nonUserBranchIndex,
		"only the non-user external-reload branch may cancel a transaction",
	);
	assert(
		warningSection?.includes('"concurrent-typing-warning"'),
		"remote typing advisory emits a warning trace",
	);
	assert(
		!warningSection?.includes('"concurrent-typing-blocked"'),
		"remote typing advisory emits no blocked trace",
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
	assert(!editorBindingSource.includes("mergeTexts3"), "binding layer never performs three-way merge");
	assert(!editorBindingSource.includes("partialMergedText"), "binding layer never applies partial merges");
	assert(
		!section?.includes("beforeContentByTransaction"),
		"Y.Text patch capture does not store pre-patch base content for live merge",
	);
	assert(
		!section?.includes("baseContent"),
		"pending Y.Text patch does not include live merge baseContent",
	);
}

console.log("\n--- Test 9c: modify attribution cannot hide suppression-window external writes ---");
{
	const modifySection = sliceBetween(
		mainSource,
		'this.app.vault.on("modify", (file) => {',
		'this.app.vault.on("rename", (file, oldPath) => {',
	);
	const bindingWiringSection = sliceBetween(
		mainSource,
		"this.editorBindings = new EditorBindingManager(",
		"// 3. Global CM6 extension",
	);
	assert(modifySection !== null, "vault modify handler section found");
	assert(bindingWiringSection !== null, "EditorBindingManager wiring section found");
	assert(
		modifySection?.includes("editorBindingsAtEvent?.isBound(file.path)"),
		"every bound external modify event enters mutation attribution",
	);
	assert(
		(modifySection?.indexOf("editorBindingsAtEvent.beginExternalDiskMutation") ?? Infinity) <
			(modifySection?.indexOf("void (async () => {") ?? -1),
		"bound modify events record synchronous ordering before asynchronous proof",
	);
	assert(
		modifySection?.includes("dm.probeRecentWriteFingerprint("),
		"timing-attributed KAOS writes are verified against their exact event revision",
	);
	assert(
		modifySection?.includes('if (probe.kind === "self-write") return;'),
		"only an exact self-write fingerprint bypasses the external reload guard",
	);
	assert(
		modifySection?.includes("this.diskMirror !== dm || this.editorBindings !== editorBindingsAtEvent"),
		"late proof is fenced to the runtime and binding manager that observed the event",
	);
	assert(
		(modifySection?.indexOf("this.diskMirror !== dm || this.editorBindings !== editorBindingsAtEvent") ?? Infinity) <
			(modifySection?.indexOf("editorBindingsAtEvent.noteExternalDiskMutation({") ?? -1),
		"stable runtime proof is checked before external mutation admission",
	);
	assert(
		modifySection?.includes("editorBindingsAtEvent.noteExternalDiskMutation({"),
		"proven bound external writes are admitted to EditorBindingManager",
	);
	assert(
		!modifySection?.includes("getEffectiveExternalEditPolicy(") &&
			!modifySection?.includes("externalEditPolicy"),
		"vault modify admission has no explicit always-policy bypass",
	);
	assert(
		bindingWiringSection?.includes("() => true,"),
		"EditorBindingManager external reload guard is fixed enabled at wiring",
	);
	assert(
		bindingWiringSection?.includes(
			"this.reconciliationController.noteInterceptedExternalDiskMutation(candidate)",
		),
		"every intercepted candidate routes directly to the controller safe lane",
	);
	assert(
		!bindingWiringSection?.includes("effectivePolicy") &&
			!bindingWiringSection?.includes("externalEditPolicy"),
		"intercepted-candidate wiring has no runtime policy branch",
	);
	assert(
		!bindingWiringSection?.includes("preserveRejectedExternalEditorReload"),
		"intercepted-candidate wiring has no legacy rejected-reload preservation path",
	);
}

console.log("\n--- Test 10: editor-health heal is attach-only ---");
{
	const healSection = sliceBetween(
		bindingSource,
		"heal(view: MarkdownView, deviceName: string, reason: string): boolean {",
		"rebind(view: MarkdownView, deviceName: string, reason: string): void {",
	);
	assert(healSection !== null, "heal section found");
	assert(
		!healSection?.includes("applyDiffToYText("),
		"heal does not write editor content into Y.Text",
	);
	assert(
		!bindingSource.match(/applyDiffToYText[^\n)]*ORIGIN_EDITOR_HEALTH_HEAL/),
		"editor-health-heal origin is never a binding-layer writer",
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
			(targetSection?.indexOf("this.requestOpenPathAdmission(") ?? -1),
		"binding target checks syncability before admission",
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

console.log("\n--- Test 13: binding is attach-only and every bind site is managed ---");
{
	const bindSection = sliceBetween(
		bindingSource,
		"bind(view: MarkdownView, deviceName: string): void {",
		"repair(view: MarkdownView, deviceName: string, reason: string): boolean {",
	);
	const repairSection = sliceBetween(
		bindingSource,
		"repair(view: MarkdownView, deviceName: string, reason: string): boolean {",
		"heal(view: MarkdownView, deviceName: string, reason: string): boolean {",
	);
	const healSection = sliceBetween(
		bindingSource,
		"heal(view: MarkdownView, deviceName: string, reason: string): boolean {",
		"rebind(view: MarkdownView, deviceName: string, reason: string): void {",
	);
	const rebindSection = sliceBetween(
		bindingSource,
		"rebind(view: MarkdownView, deviceName: string, reason: string): void {",
		"/**\n\t * Unbind a MarkdownView's editor",
	);
	const staleUserSection = sliceBetween(
		bindingSource,
		"private fenceStaleUserBinding(transaction: Transaction): TransactionSpec | null {",
		"private hasRecentUserDocumentEdit(",
	);
	const healthSection = sliceBetween(
		bindingSource,
		"private maybeHealBinding(",
		"private scheduleCmResolveRetry(",
	);
	const workspaceBindSection = sliceBetween(
		workspaceSource,
		"private bindView(view: MarkdownView): void {",
		"private trackOpenFile(path: string): void {",
	);
	const validateSection = sliceBetween(
		workspaceSource,
		"validateOpenBindings(reason: string): void {",
		"auditBindings(reason: string): number {",
	);

	assert(!bindingSource.includes(".ensureFile("), "editor binding contains no ensureFile writer");
	assert(
		(bindingSource.match(/this\.requestOpenPathAdmission\(/g) ?? []).length === 1,
		"editor binding has one exact admission request invocation",
	);
	assert(
		!healSection?.includes("applyDiffToYText("),
		"heal is attach-only and never writes editor bytes into Y.Text",
	);
	for (const [name, section] of [
		["bind", bindSection],
		["repair", repairSection],
		["heal", healSection],
		["rebind", rebindSection],
		["stale user", staleUserSection],
		["health", healthSection],
	]) {
		assert(section !== null, `${name} section found for handoff routing`);
		assert(
			section?.includes("this.beginPathHandoff("),
			`${name} path mismatch routes through beginPathHandoff`,
		);
	}
	assert(workspaceBindSection !== null, "workspace bind section found for managed ordering");
	assert(
		(workspaceBindSection?.indexOf("bindings?.manageView(view)") ?? Infinity) <
			(workspaceBindSection?.indexOf("bindings?.bind(") ?? -1),
		"workspace bindView manages the view before bind",
	);
	assert(validateSection !== null, "workspace validation section found for managed ordering");
	assert(
		(validateSection?.indexOf("editorBindings.manageView(leaf.view)") ?? Infinity) <
			(validateSection?.indexOf("editorBindings.bind(leaf.view") ?? -1),
		"workspace validation manages the view before bind",
	);
	assert(
		!workspaceSource.includes("editorBindings.unbind(leaf.view)"),
		"layout validation never performs a direct mismatch detach",
	);
}

console.log("\n--- Test 14: reconciliation authority has one shared editor-read boundary ---");
{
	for (const [name, source] of [
		["DiskMirror", diskMirrorSource],
		["ReconciliationController", reconciliationSource],
	]) {
		assert(
			!source.includes(".editor.getValue()"),
			`${name} performs no raw editor facade authority read`,
		);
		assert(
			!source.includes("getOpenEditorAuthority("),
			`${name} has no duplicate open-editor authority helper`,
		);
		assert(
			!source.includes("type OpenEditorAuthority"),
			`${name} has no duplicate open-editor authority type`,
		);
		assert(
			source.includes("capturePathEditorAuthority("),
			`${name} consumes the shared path-scoped authority port`,
		);
		assert(
			source.includes("isPathEditorAuthorityLeaseCurrent("),
			`${name} revalidates shared editor-authority leases`,
		);
	}
}

console.log(`\n${"-".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"-".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
