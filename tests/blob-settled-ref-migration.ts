import assert from "node:assert/strict";
import { collectLegacyMissingBlobPaths } from "../src/sync/blobSettledRefMigration";
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
