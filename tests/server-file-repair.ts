import assert from "node:assert/strict";
import * as Y from "yjs";
import { commitServerFileRepair, inspectServerFile, validateRepairPath } from "../server/src/fileRepair";
import { readRepairBody } from "../server/src/routes/fileRepair";

function fixture(content = "server A", extension = "md"): Y.Doc {
	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 3);
	doc.getMap("meta").set("file", new Y.Map([["path", `Notes/file.${extension}`]]));
	doc.getMap("idToText").set("file", new Y.Text(content));
	doc.getMap("meta").set("other", new Y.Map([["path", "Notes/other.md"]]));
	doc.getMap("idToText").set("other", new Y.Text("unchanged"));
	return doc;
}
function text(doc: Y.Doc, id = "file"): Y.Text { return doc.getMap<Y.Text>("idToText").get(id)!; }
function replica(doc: Y.Doc): Y.Doc { const next = new Y.Doc(); Y.applyUpdate(next, Y.encodeStateAsUpdate(doc)); return next; }

async function main(): Promise<void> {
	for (const extension of ["md", "base"]) {
		const server = fixture("server A", extension);
		const local = replica(server);
		text(local).delete(0, text(local).length); text(local).insert(0, "unsent B");
		text(local, "other").insert(0, "pending other ");
		const stalePacket = Y.encodeStateAsUpdate(local);
		const before = await inspectServerFile(server, `Notes/file.${extension}`);
		assert.equal(before.kind, "text");
		assert.equal(before.kind === "text" && before.content, "server A");
		const observed: string[] = [];
		server.on("update", () => observed.push(text(server).toString()));
		const resolved = await commitServerFileRepair(server, before.path, before.token, Y.encodeStateAsUpdate(local));
		assert.deepEqual(observed, ["server A"], "discarded text never broadcasts as an intermediate version");
		Y.applyUpdate(local, resolved);
		assert.equal(text(local).toString(), "server A");
		assert.equal(text(local, "other").toString(), "pending other unchanged");
		// Simulate a late old socket packet and a reloaded offline replica.
		Y.applyUpdate(server, stalePacket);
		assert.equal(text(server).toString(), "server A");
		const reloaded = replica(local); Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(server));
		assert.equal(text(reloaded).toString(), "server A");
		text(local).insert(text(local).length, " new edit");
		Y.applyUpdate(server, Y.encodeStateAsUpdate(local));
		assert.equal(text(server).toString(), "server A new edit", "new edits still sync after repair");
		server.destroy(); local.destroy(); reloaded.destroy();
	}
	const empty = fixture("");
	const emptyLocal = replica(empty); text(emptyLocal).insert(0, "unwanted");
	const emptyVersion = await inspectServerFile(empty, "Notes/file.md");
	Y.applyUpdate(emptyLocal, await commitServerFileRepair(empty, emptyVersion.path, emptyVersion.token, Y.encodeStateAsUpdate(emptyLocal)));
	assert.equal(text(emptyLocal).toString(), "");
	const server = fixture(); const local = replica(server);
	const version = await inspectServerFile(server, "Notes/file.md");
	text(server).insert(0, "remote change ");
	const unchanged = Y.encodeStateAsUpdate(server);
	await assert.rejects(commitServerFileRepair(server, version.path, version.token, Y.encodeStateAsUpdate(local)), /server-changed/);
	assert.deepEqual(Y.encodeStateAsUpdate(server), unchanged, "stale repair never changes server state");
	const fresh = await inspectServerFile(server, version.path);
	await assert.rejects(commitServerFileRepair(server, fresh.path, fresh.token, new Uint8Array([255])), /invalid-local-update/);
	assert.deepEqual(Y.encodeStateAsUpdate(server), unchanged);
	local.getMap("sys").set("schemaVersion", 99);
	await assert.rejects(commitServerFileRepair(server, fresh.path, fresh.token, Y.encodeStateAsUpdate(local)), /room-schema-changed/);
	assert.equal((await inspectServerFile(server, "missing.md")).kind, "missing");
	server.getMap("meta").set("deleted", new Y.Map<string | number>([["path", "deleted.md"], ["deletedAt", 123]]));
	assert.equal((await inspectServerFile(server, "deleted.md")).kind, "deleted");
	const blob = new Y.Doc(); blob.getMap("sys").set("schemaVersion", 3);
	const hash = "a".repeat(64); blob.getMap("pathToBlob").set("file.canvas", { hash, size: 0 });
	blob.getMap("blobTombstones").set("file.canvas", { deletedAt: 1 });
	const blobLocal = replica(blob); blobLocal.getMap("pathToBlob").set("file.canvas", { hash: "b".repeat(64), size: 9 });
	const blobVersion = await inspectServerFile(blob, "file.canvas");
	assert.equal(blobVersion.kind, "blob", "live refs win over stale tombstones");
	Y.applyUpdate(blobLocal, await commitServerFileRepair(blob, blobVersion.path, blobVersion.token, Y.encodeStateAsUpdate(blobLocal)));
	assert.equal((blobLocal.getMap("pathToBlob").get("file.canvas") as { hash: string }).hash, hash);
	for (const path of ["../bad", "/absolute", "a//b", "a\\b", "", "a/./b"]) assert.throws(() => validateRepairPath(path), /invalid-path/);
	const overflow = new Request("https://test", { method: "POST", body: new Uint8Array(8 * 1024 * 1024 + 1) });
	await assert.rejects(readRepairBody(overflow), /repair-update-too-large/);
	// Oversized room CRDT: inspect succeeds with oversized: true instead of 413, and atomic commit rejects with 413
	const oversizedServer = fixture("oversized note");
	const largeChunk = "x".repeat(8 * 1024 * 1024 + 10);
	oversizedServer.getMap("idToText").set("large", new Y.Text(largeChunk));
	const oversizedVersion = await inspectServerFile(oversizedServer, "Notes/file.md");
	assert.equal(oversizedVersion.kind, "text");
	assert.equal(oversizedVersion.oversized, true, "oversized room marks inspect version as oversized");
	assert.equal(oversizedVersion.kind === "text" && oversizedVersion.content, "oversized note");
	assert.match(oversizedVersion.token, /^[a-f0-9]{64}$/, "oversized version produces a valid SHA-256 token");
	await assert.rejects(commitServerFileRepair(oversizedServer, oversizedVersion.path, oversizedVersion.token, new Uint8Array([0])), /repair-state-too-large/);

	console.log("PASS server-file-repair: atomic repair, offline replay, Base, empty content, Blob, CAS, schema and body boundaries, oversized room recovery");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
