import assert from "node:assert/strict";
import { TFile } from "obsidian";
import {
	captureConflictResolutionSnapshot,
	resolveConflictArtifactWithCas,
} from "../src/dashboard/conflictResolution";

class FakeTFile extends TFile {
	constructor(
		readonly path: string,
		readonly stat: { ctime: number; mtime: number; size: number },
	) {
		super();
	}
}

class FakeVault {
	readonly files = new Map<string, FakeTFile>();
	readonly contents = new Map<FakeTFile, string>();
	processCalls = 0;
	deleteCalls = 0;
	afterProcess: ((file: FakeTFile) => void) | null = null;
	afterLookup: ((path: string, file: FakeTFile | null, call: number) => void) | null = null;
	private readonly lookupCalls = new Map<string, number>();

	add(path: string, content: string): FakeTFile {
		const file = new FakeTFile(path, { ctime: 1, mtime: 1, size: content.length });
		this.files.set(path, file);
		this.contents.set(file, content);
		return file;
	}

	mutate(file: FakeTFile, content: string): void {
		this.contents.set(file, content);
		file.stat.mtime++;
		file.stat.size = content.length;
	}

	replace(path: string, content: string): FakeTFile {
		const replacement = new FakeTFile(path, { ctime: 2, mtime: 2, size: content.length });
		this.files.set(path, replacement);
		this.contents.set(replacement, content);
		return replacement;
	}

	getAbstractFileByPath(path: string): FakeTFile | null {
		const file = this.files.get(path) ?? null;
		const call = (this.lookupCalls.get(path) ?? 0) + 1;
		this.lookupCalls.set(path, call);
		this.afterLookup?.(path, file, call);
		return file;
	}

	async read(file: FakeTFile): Promise<string> {
		const content = this.contents.get(file);
		if (content === undefined) throw new Error(`missing: ${file.path}`);
		return content;
	}

	async process(file: FakeTFile, transform: (current: string) => string): Promise<string> {
		this.processCalls++;
		const current = await this.read(file);
		const next = transform(current);
		this.mutate(file, next);
		this.afterProcess?.(file);
		return next;
	}

	async delete(file: FakeTFile): Promise<void> {
		this.deleteCalls++;
		// Model the unsafe path-based behavior available to callers when the host
		// offers no identity-aware conditional delete.
		this.files.delete(file.path);
		this.contents.delete(file);
	}
}

function fixture() {
	const vault = new FakeVault();
	const originalFile = vault.add("notes/a.md", "original\n");
	const artifactFile = vault.add("notes/a (KAOS conflict).md", "artifact\n");
	const snapshot = captureConflictResolutionSnapshot({
		originalPath: originalFile.path,
		artifactPath: artifactFile.path,
		originalFile,
		artifactFile,
		originalText: "original\n",
		artifactText: "artifact\n",
	});
	return { vault, originalFile, artifactFile, snapshot };
}

console.log("\n--- Dashboard conflict resolution CAS ---");

{
	const { vault, originalFile, artifactFile, snapshot } = fixture();
	await resolveConflictArtifactWithCas(vault as any, snapshot, { kind: "artifact" });
	assert.equal(await vault.read(originalFile), "artifact\n", "selected artifact replaces the exact original snapshot");
	assert.equal(vault.getAbstractFileByPath(artifactFile.path), artifactFile, "resolved artifact is retained as a safety copy");
	assert.equal(vault.processCalls, 1, "original replacement uses one atomic process CAS");
	assert.equal(vault.deleteCalls, 0, "resolution never attempts a non-conditional artifact delete");
}

{
	const { vault, originalFile, artifactFile, snapshot } = fixture();
	vault.mutate(originalFile, "new editor content\n");
	await assert.rejects(
		resolveConflictArtifactWithCas(vault as any, snapshot, { kind: "artifact" }),
		/changed after the diff was opened/,
	);
	assert.equal(await vault.read(originalFile), "new editor content\n", "stale resolution never overwrites a newer original");
	assert.equal(vault.getAbstractFileByPath(artifactFile.path), artifactFile, "stale original keeps the artifact");
	assert.equal(vault.deleteCalls, 0, "stale original is rejected before delete");
}

{
	const { vault, originalFile, artifactFile, snapshot } = fixture();
	vault.mutate(artifactFile, "new artifact content\n");
	await assert.rejects(
		resolveConflictArtifactWithCas(vault as any, snapshot, { kind: "artifact" }),
		/changed after the diff was opened/,
	);
	assert.equal(await vault.read(originalFile), "original\n", "stale artifact never changes the original");
	assert.equal(vault.getAbstractFileByPath(artifactFile.path), artifactFile, "stale artifact remains available");
	assert.equal(vault.processCalls, 0, "artifact is validated before original CAS");
}

{
	const { vault, originalFile, artifactFile, snapshot } = fixture();
	vault.mutate(artifactFile, "artifact\n");
	await assert.rejects(
		resolveConflictArtifactWithCas(vault as any, snapshot, { kind: "original" }),
		/changed after the diff was opened/,
	);
	assert.equal(await vault.read(originalFile), "original\n", "same-content artifact rewrites do not touch the original");
	assert.equal(vault.getAbstractFileByPath(artifactFile.path), artifactFile, "same-content rewrite still keeps the artifact");
	assert.equal(vault.processCalls, 0, "Keep original validates without generating a no-op disk write");
}

{
	const { vault, originalFile, artifactFile, snapshot } = fixture();
	let raced = false;
	vault.afterProcess = (file) => {
		if (file !== originalFile || raced) return;
		raced = true;
		vault.mutate(artifactFile, "artifact changed during CAS\n");
	};
	await assert.rejects(
		resolveConflictArtifactWithCas(vault as any, snapshot, { kind: "artifact" }),
		/changed after the diff was opened/,
	);
	assert.equal(
		await vault.read(originalFile),
		"artifact\n",
		"artifact race never triggers a byte-only compensating write that could overwrite a same-content ABA",
	);
	assert.equal(await vault.read(artifactFile), "artifact changed during CAS\n", "racing artifact content is preserved");
	assert.equal(vault.getAbstractFileByPath(artifactFile.path), artifactFile, "artifact race never deletes the artifact");
	assert.equal(vault.processCalls, 1, "post-commit validation never performs a compensating disk write");
}

{
	const { vault, originalFile, artifactFile, snapshot } = fixture();
	let raced = false;
	vault.afterProcess = (file) => {
		if (file !== originalFile || raced) return;
		raced = true;
		vault.mutate(originalFile, "typing during resolution\n");
	};
	await assert.rejects(
		resolveConflictArtifactWithCas(vault as any, snapshot, { kind: "merged", mergedText: "merged\n" }),
		/changed while the resolution was being applied/,
	);
	assert.equal(await vault.read(originalFile), "typing during resolution\n", "rollback never overwrites a newer editor write");
	assert.equal(vault.getAbstractFileByPath(artifactFile.path), artifactFile, "concurrent original write keeps the artifact");
	assert.equal(vault.deleteCalls, 0, "concurrent original write is rejected before delete");
}

{
	const { vault, originalFile, artifactFile, snapshot } = fixture();
	let replacementArtifact: FakeTFile | null = null;
	vault.afterLookup = (path, file, call) => {
		if (path !== artifactFile.path || file !== artifactFile || call !== 5) return;
		// The fifth artifact lookup is the final post-commit identity check. Swap
		// the path immediately after that check, in the gap where the old code
		// proceeded to an unconditional Vault.delete.
		replacementArtifact = vault.replace(path, "artifact\n");
	};
	await resolveConflictArtifactWithCas(vault as any, snapshot, { kind: "merged", mergedText: "merged\n" });
	assert.equal(await vault.read(originalFile), "merged\n", "the selected resolution still commits before the former delete gap");
	assert.ok(replacementArtifact, "a same-bytes replacement artifact is installed in the former delete gap");
	assert.equal(
		vault.getAbstractFileByPath(artifactFile.path),
		replacementArtifact,
		"the replacement artifact survives because resolution never performs a path-based delete",
	);
	assert.equal(await vault.read(replacementArtifact), "artifact\n", "replacement artifact bytes remain intact");
	assert.equal(vault.deleteCalls, 0, "the delete-gap race cannot reach any delete primitive");
}

console.log("PASS dashboard conflict resolution CAS");
