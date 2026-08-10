import assert from "node:assert/strict";
import {
	AssertionError,
	assertNoConflictCopies,
} from "../qa/obsidian-harness/assertions";

function appWithFiles(paths: string[]): never {
	return {
		vault: {
			getFiles: () => paths.map((path) => ({ path })),
		},
	} as never;
}

async function assertConflictRejected(path: string): Promise<void> {
	await assert.rejects(
		assertNoConflictCopies(appWithFiles([path]), "QA-s07"),
		(error: unknown) =>
			error instanceof AssertionError &&
			error.message.includes(path),
		`expected canonical conflict artifact to be rejected: ${path}`,
	);
}

await assertNoConflictCopies(appWithFiles([
	"QA-s07/2026-08-07.md",
	"Elsewhere/note (KAOS conflict - editor from workspace 2026-08-07T03-00-10Z).md",
]), "QA-s07");

await assertConflictRejected(
	"QA-s07/2026-08-07 (KAOS conflict - editor from workspace 2026-08-07T03-00-10Z) 2.md",
);
await assertConflictRejected(
	"QA-s07/2026-08-07 (KAOS conflict - crdt from laptop 2026-08-07T03-00-11Z).md",
);
await assertConflictRejected(
	"QA-s07/2026-08-07 (KAOS conflict - disk from phone 2026-08-07T03-00-12Z).md",
);

console.log("qa harness conflict assertion: PASS");
