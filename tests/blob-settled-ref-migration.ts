import assert from "node:assert/strict";
import {
	collectLegacyMissingBlobPaths,
	scrubBlobSettlementDocumentOwnership,
} from "../src/sync/blobSettledRefMigration";
import type { BlobHashCache } from "../src/sync/blobHashCache";

const hash = "a".repeat(64);
const cache: BlobHashCache = {
	"assets/deleted.png": { mtime: 1, size: 10, hash },
	"./assets\\renamed-away.png": { mtime: 2, size: 20, hash },
	"assets/present.png": { mtime: 3, size: 30, hash },
	"notes/not-a-blob.md": { mtime: 4, size: 40, hash },
	"assets/invalid.png": { mtime: 5, size: 50, hash: "not-a-hash" },
};

console.log("\n--- Blob v4 settled-ref migration planning ---");

const present = new Set(["assets/present.png"]);
const existingDevice = collectLegacyMissingBlobPaths({
	identityStatus: "existing",
	hashCache: cache,
	isPathPresent: (path) => present.has(path),
	isPathSyncable: (path) => !path.endsWith(".md"),
});
assert.deepEqual(
	existingDevice,
	["assets/deleted.png", "assets/renamed-away.png"],
	"only valid legacy-known blob paths missing on this existing installation are quarantined",
);

for (const identityStatus of ["created", "unknown"] as const) {
	assert.deepEqual(
		collectLegacyMissingBlobPaths({
			identityStatus,
			hashCache: cache,
			isPathPresent: () => false,
			isPathSyncable: () => true,
		}),
		[],
		`${identityStatus} identity never borrows a copied data.json hash cache as bootstrap authority`,
	);
}

console.log("PASS blob v4 settled-ref migration planning\n");

console.log("--- Blob document-ownership settlement scrub ---");

const scrubbed = scrubBlobSettlementDocumentOwnership({
	cache: {
		"assets/kept.png": { hash: "kept" },
		"BACKLOG/BACKLOG.base": { hash: "legacy-base" },
	},
	sourceVersions: {
		"assets/kept.png": "source-kept",
		"BACKLOG/BACKLOG.base": "source-base",
	},
	stages: {
		"assets/kept.png": { kind: "download" },
		"BACKLOG (KAOS local backup 20260717T010203Z abc12345)/image.png": {
			kind: "download",
		},
	},
	legacyMissingPaths: [
		"assets/missing.png",
		"BACKLOG/BACKLOG.base",
	],
	isPathBlobSyncable: (path) =>
		!path.endsWith(".base") && !path.includes("(KAOS local backup "),
});

assert.deepEqual(
	scrubbed.cache,
	{ "assets/kept.png": { hash: "kept" } },
	"legacy Base refs are removed from attachment settlement authority",
);
assert.deepEqual(
	scrubbed.sourceVersions,
	{ "assets/kept.png": "source-kept" },
	"legacy Base source versions are removed with their attachment ownership",
);
assert.deepEqual(
	scrubbed.stages,
	{ "assets/kept.png": { kind: "download" } },
	"excluded safety-subtree stages are removed from attachment ownership",
);
assert.deepEqual(
	scrubbed.legacyMissingPaths,
	["assets/missing.png"],
	"document paths are removed from legacy attachment Attention state",
);
assert.equal(scrubbed.changed, true, "ownership scrub reports a durable migration");

console.log("PASS blob document-ownership settlement scrub\n");
