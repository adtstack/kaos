import assert from "node:assert/strict";
import { Modal } from "obsidian";
import { KaosDashboardView } from "../src/dashboard/KaosDashboardView";
import { ConfirmModal } from "../src/ui/ConfirmModal";
import { FullVaultRestoreConfirmModal } from "../src/snapshots/fullRestoreModal";
import { SnapshotDiffModal } from "../src/snapshots/snapshotModals";
import { requiresTypedFullRestoreConfirmation } from "../src/snapshots/fullRestore";
import type { SnapshotDiff } from "../src/sync/snapshotClient";

// Small DOM surface for exercising actual modal handlers and text.
class Element {
	children: Element[] = []; listeners = new Map<string, Array<() => void>>();
	text = ""; tag = "div"; value = ""; disabled = false; title = ""; readOnly = false;
	classList = { add() {}, remove() {} };
	createEl(tag: string, options: { text?: string; cls?: string } = {}) {
		const child = new Element(); child.tag = tag; child.text = options.text ?? ""; this.children.push(child); return child;
	}
	createDiv(options = {}) { return this.createEl("div", options); }
	addClass() {} removeClass() {} empty() { this.children = []; } focus() {} setAttribute() {}
	addEventListener(kind: string, callback: () => void) { this.listeners.set(kind, [...this.listeners.get(kind) ?? [], callback]); }
	fire(kind: string) { for (const callback of this.listeners.get(kind) ?? []) callback(); }
	all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
	querySelectorAll() { return []; }
}
const render = (modal: Modal & { onOpen(): void }) => {
	const content = new Element(); Object.assign(modal, { contentEl: content, modalEl: new Element() }); modal.onOpen(); return content;
};
const emptyDiff = (): SnapshotDiff => ({ contentChanged: [], deletedSinceSnapshot: [], createdSinceSnapshot: [], unchanged: [], blobsChanged: [], blobsDeletedSinceSnapshot: [], blobsCreatedSinceSnapshot: [] });
const resolution = { kind: "markdown-conflict", fileKind: "markdown", reason: "three-way-preserve-failed", episodeId: "review", canKeepLocal: true, canUseRemote: true } as const;
const oldOpen = Modal.prototype.open;
let opened: any;
Modal.prototype.open = function () { opened = this; };
try {
	for (const base of ["baseline\n", null]) {
		let local = "local\n";
		const calls: unknown[] = [];
		const view = new KaosDashboardView({ app: {} } as never, {
			collectData: async () => { throw new Error("unused"); },
			getBaselineText: () => base,
			getMarkdownConflictReviewSides: async () => ({ path: "note.md", localText: local, remoteText: "remote\n", baseHash: base ? "base-hash" : null }),
			actions: { resolveMarkdownConflictAttention: async (target: unknown, choice: unknown) => { calls.push({ target, choice }); return { status: "completed" }; } } as never,
		});
		Object.assign(view, { render: () => {}, refresh: async () => {} });
		await view["openMarkdownConflictReview"]("note.md", resolution as never);
		const modal = opened;
		assert.equal(modal.data.context, "attention");
		const content = render(modal); const texts = content.all().map(element => element.text);
		assert(texts.includes("Local (disk)")); assert(texts.includes("Remote (sync)"));
		assert(texts.includes(base === null ? "Manual merge" : "3-way merge"));
		assert.equal(modal.data.baseText, base);
		for (const [kind, mapped] of [["original", "keep-local"], ["artifact", "use-remote"], ["merged", "use-merged"]]) {
			await modal.data.onResolve({ kind, mergedText: "reviewed merge" });
			const choice = (calls.at(-1) as any).choice;
			assert.equal(typeof choice === "string" ? choice : choice.kind, mapped);
			if (kind === "merged") assert.equal(choice.expectedLocalText, "local\n");
		}
		modal.confirmResolution({ kind: "merged", mergedText: "reviewed merge" });
		assert.equal(opened.message, "Apply the merged result to this note?");
		const count = calls.length; local = "newer local";
		await assert.rejects(modal.data.onResolve({ kind: "merged", mergedText: "stale" }), /Reopen/);
		assert.equal(calls.length, count, "changed reviewed sides never reach the controller");
		console.log(`PASS conflict review UI ${base === null ? "two-way" : "three-way"}`);
	}
	for (const [total, removals, typed] of [[200, 0, false], [201, 0, true], [50, 50, false], [51, 51, true]]) {
		const diff = emptyDiff();
		diff.createdSinceSnapshot = Array.from({ length: removals }, (_, i) => `created-${i}.md`);
		diff.contentChanged = Array.from({ length: total - removals }, (_, i) => ({ path: `${i}.md`, fileId: `${i}`, snapshotContent: "old", currentContent: "new" }));
		assert.equal(requiresTypedFullRestoreConfirmation(diff), typed);
		let submitted = 0;
		const modal = new FullVaultRestoreConfirmModal({} as never, diff, () => { submitted++; });
		const content = render(modal); const elements = content.all();
		assert(elements.some(el => el.text.includes("Obsidian trash") && el.text.includes("KAOS local backup")));
		const confirm = elements.find(el => el.text === "Restore entire vault")!;
		assert.equal(confirm.disabled, typed);
		if (typed) {
			const input = elements.find(el => el.tag === "input")!;
			input.value = "wrong"; input.fire("input"); confirm.fire("click");
			await Promise.resolve(); assert.equal(submitted, 0);
			input.value = "restore"; input.fire("input"); assert.equal(confirm.disabled, false);
		}
		confirm.fire("click"); confirm.fire("click"); await Promise.resolve(); await Promise.resolve();
		assert.equal(submitted, 1, "confirm submits exactly once");
	}
	// A blob-only created-since diff must still expose full restore and transfer cleanup ownership.
	const diff = emptyDiff(); diff.blobsCreatedSinceSnapshot = ["new.png"];
	let cleaned = 0, restored = 0;
	const modal = new SnapshotDiffModal({} as never, { createdAt: new Date().toISOString() } as never, diff, () => {}, () => { cleaned++; }, () => { restored++; });
	const content = render(modal);
	const full = content.all().find(el => el.text === "Restore entire vault to this snapshot")!;
	assert(full && !full.disabled); full.fire("click");
	assert(opened instanceof FullVaultRestoreConfirmModal);
	await opened.onConfirm(); modal.onClose();
	assert.equal(restored, 1); assert.equal(cleaned, 0, "full restore caller owns snapshot cleanup");
	console.log("PASS full restore confirmation thresholds, destinations, blob-only entry and cleanup");
} finally { Modal.prototype.open = oldOpen; }
