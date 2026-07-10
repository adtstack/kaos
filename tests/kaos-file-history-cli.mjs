#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

const before = "before line\nshared line\n";
const after = "after line\nshared line\n";
const beforeHash = sha256(before);
const afterHash = sha256(after);
const manifest = {
	storageVersion: "v2",
	manifestId: "m-history-1",
	vaultId: "vault-history",
	kind: "file-history",
	createdAt: "2026-07-10T01:23:00.000Z",
	day: "2026-07-10",
	reason: "automatic",
	pinned: false,
	changedCount: 1,
	contentHashes: [beforeHash, afterHash],
	changedEntries: [{
		fileId: "file-1",
		kind: "modified",
		path: "notes/plan.md",
		contentHash: afterHash,
		previousContentHash: beforeHash,
	}],
	stateHash: "state",
	manifestHash: "manifest",
};

const server = createServer((req, res) => {
	if (req.headers.authorization !== "Bearer test-token") {
		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "unauthorized" }));
		return;
	}
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname === "/vault/vault-history/recovery-snapshots") {
		assert.equal(url.searchParams.get("limit"), "1", "CLI forwards the requested history page size");
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			manifests: [manifest],
			totalManifestKeys: 2,
			limited: true,
			nextCursor: manifest.manifestId,
		}));
		return;
	}
	if (url.pathname === `/vault/vault-history/recovery-snapshots/${manifest.manifestId}/manifest`) {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(manifest));
		return;
	}
	if (url.pathname === `/vault/vault-history/recovery-content/${beforeHash}`) {
		res.writeHead(200, { "Content-Type": "application/gzip" });
		res.end(gzipSync(before));
		return;
	}
	if (url.pathname === `/vault/vault-history/recovery-content/${afterHash}`) {
		res.writeHead(200, { "Content-Type": "application/gzip" });
		res.end(gzipSync(after));
		return;
	}
	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "not found" }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string", "history test server listens on a TCP port");
const baseArgs = [
	"--host", `http://127.0.0.1:${address.port}`,
	"--vault-id", "vault-history",
	"--token", "test-token",
];

try {
	console.log("\n--- kaos file history CLI: list, show, and diff ---");
	const list = await run(["history", "list", "--limit", "1", "--json", ...baseArgs]);
	assert.equal(list.status, 0, list.stderr || list.stdout);
	const listPayload = JSON.parse(list.stdout);
	assert.equal(listPayload.kind, "kaos-file-history");
	assert.equal(listPayload.manifests[0].manifestId, manifest.manifestId);
	assert.equal(listPayload.nextCursor, manifest.manifestId);

	const show = await run(["history", "show", manifest.manifestId, "--json", ...baseArgs]);
	assert.equal(show.status, 0, show.stderr || show.stdout);
	assert.equal(JSON.parse(show.stdout).changedEntries[0].path, "notes/plan.md");

	const diff = await run(["history", "diff", `${manifest.manifestId}:0`, ...baseArgs]);
	assert.equal(diff.status, 0, diff.stderr || diff.stdout);
	assert.match(diff.stdout, /--- before:notes\/plan\.md/);
	assert.match(diff.stdout, /\+after line/);
	assert.match(diff.stdout, /-before line/);
	console.log("  PASS  CLI reads paged history, event details, and verified content diffs");
} finally {
	await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

function run(args) {
	const child = spawn(process.execPath, ["scripts/kaosctl.mjs", ...args], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (status) => resolve({ status, stdout, stderr }));
	});
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
