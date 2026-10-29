import * as Y from "yjs";
import { decodeRecoveryFileMeta } from "./recoverySnapshot";
import { sha256Hex } from "./hex";

export const MAX_FILE_REPAIR_BYTES = 8 * 1024 * 1024;

type ServerFileState =
	| { kind: "text"; fileId: string; content: string }
	| { kind: "blob"; ref: { hash: string; size: number; priorHashes?: string[] } }
	| { kind: "missing" }
	| { kind: "deleted" };

export type ServerFileVersion = {
	protocol: 1;
	path: string;
	token: string;
	schema: number;
	oversized?: boolean;
} & ServerFileState;

export class FileRepairError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

export function validateRepairPath(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096
		|| value.includes("\\") || [...value].some((character) => character.charCodeAt(0) < 32) || value.startsWith("/")
		|| value.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new FileRepairError(400, "invalid-path");
	}
	return value;
}

function fileState(doc: Y.Doc, path: string): ServerFileState {
	if (/\.(md|base)$/.test(path)) {
		const candidates: string[] = [];
		let deleted = false;
		doc.getMap("meta").forEach((raw, id) => {
			const meta = decodeRecoveryFileMeta(raw);
			if (meta?.path !== path) return;
			if (meta.deleted || meta.deletedAt !== undefined) deleted = true;
			else candidates.push(id);
		});
		// Legacy rooms may not have metadata for every active path.
		const legacy = doc.getMap<string>("pathToId").get(path);
		if (candidates.length === 0 && legacy && !deleted) candidates.push(legacy);
		if (candidates.length > 1) throw new FileRepairError(409, "path-collision");
		const id = candidates[0];
		if (!id) return { kind: deleted ? "deleted" : "missing" };
		const text = doc.getMap<Y.Text>("idToText").get(id);
		if (!(text instanceof Y.Text)) throw new FileRepairError(409, "missing-server-text");
		return { kind: "text", fileId: id, content: text.toJSON() };
	}
	const ref = doc.getMap<{ hash: string; size: number; priorHashes?: string[] }>("pathToBlob").get(path);
	if (!ref) return { kind: doc.getMap("blobTombstones").has(path) ? "deleted" : "missing" };
	if (!/^[a-f0-9]{64}$/.test(ref.hash) || !Number.isSafeInteger(ref.size) || ref.size < 0) {
		throw new FileRepairError(409, "invalid-server-blob");
	}
	return { kind: "blob", ref: { hash: ref.hash, size: ref.size, ...(Array.isArray(ref.priorHashes) ? { priorHashes: [...ref.priorHashes] } : {}) } };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export async function inspectServerFile(doc: Y.Doc, rawPath: unknown): Promise<ServerFileVersion> {
	const path = validateRepairPath(rawPath);
	const state = fileState(doc, path);
	const schema = doc.getMap("sys").get("schemaVersion");
	if (typeof schema !== "number" || !Number.isSafeInteger(schema) || schema < 1) throw new FileRepairError(409, "unknown-server-schema");
	const snapshot = Y.encodeStateAsUpdate(doc);
	if (snapshot.length > MAX_FILE_REPAIR_BYTES) {
		const token = await sha256Hex(new TextEncoder().encode(JSON.stringify({ path, schema, state })));
		return { protocol: 1, path, schema, token, oversized: true, ...state };
	}
	const token = await sha256Hex(snapshot);
	if (!bytesEqual(snapshot, Y.encodeStateAsUpdate(doc))) throw new FileRepairError(409, "server-changed");
	return { protocol: 1, path, schema, token, oversized: false, ...state };
}

function copyValue(value: unknown): unknown {
	if (value instanceof Y.Map) {
		const result = new Y.Map();
		value.forEach((child, key) => result.set(key, copyValue(child)));
		return result;
	}
	return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Resume the pending replica update and correct the selected file in ONE
 * server transaction. Publishing the pending update first over a socket would
 * briefly expose discarded text (or merge it back into the selected version).
 * Unrelated pending edits are normal sync work and are retained in this batch.
 */
export async function commitServerFileRepair(
	doc: Y.Doc, rawPath: unknown, token: unknown, localUpdate: Uint8Array,
): Promise<Uint8Array> {
	if (localUpdate.length > MAX_FILE_REPAIR_BYTES) throw new FileRepairError(413, "repair-update-too-large");
	const version = await inspectServerFile(doc, rawPath);
	if (version.oversized) throw new FileRepairError(413, "repair-state-too-large");
	if (version.token !== token) throw new FileRepairError(409, "server-changed");
	if (version.kind !== "text" && version.kind !== "blob") throw new FileRepairError(404, version.kind);
	const original = Y.encodeStateAsUpdate(doc);
	const trial = new Y.Doc();
	try {
		Y.applyUpdate(trial, original);
		Y.applyUpdate(trial, localUpdate);
		if (trial.store.pendingStructs || trial.store.pendingDs) throw new FileRepairError(409, "incomplete-local-update");
		if (JSON.stringify(trial.getMap("sys").toJSON()) !== JSON.stringify(doc.getMap("sys").toJSON())) {
			throw new FileRepairError(409, "room-schema-changed");
		}
		trial.transact(() => {
			if (version.kind === "text") {
				const meta = doc.getMap("meta").get(version.fileId);
				if (JSON.stringify(trial.getMap("meta").get(version.fileId)) !== JSON.stringify(meta)) {
					if (meta === undefined) trial.getMap("meta").delete(version.fileId);
					else trial.getMap("meta").set(version.fileId, copyValue(meta));
				}
				const legacy = doc.getMap("pathToId").get(version.path);
				if (legacy !== undefined && trial.getMap("pathToId").get(version.path) !== legacy) {
					trial.getMap("pathToId").set(version.path, legacy);
				}
				let text = trial.getMap<Y.Text>("idToText").get(version.fileId);
				if (!text) { text = new Y.Text(); trial.getMap("idToText").set(version.fileId, text); }
				if (text.toJSON() !== version.content) {
					text.delete(0, text.length);
					text.insert(0, version.content);
				}
			} else {
				trial.getMap("pathToBlob").set(version.path, version.ref);
				// A live ref wins over a stale tombstone, as in normal BlobSync.
			}
		});
		const resolved = fileState(trial, version.path);
		if (resolved.kind !== version.kind
			|| (version.kind === "text" && (resolved.kind !== "text" || resolved.fileId !== version.fileId || resolved.content !== version.content))) {
			throw new FileRepairError(409, "local-path-identity-changed");
		}
		// No awaits between the final authority check and the atomic apply.
		if (!bytesEqual(original, Y.encodeStateAsUpdate(doc))) throw new FileRepairError(409, "server-changed");
		const update = Y.encodeStateAsUpdate(trial, Y.encodeStateVector(doc));
		if (Y.encodeStateAsUpdate(trial).length > MAX_FILE_REPAIR_BYTES) throw new FileRepairError(413, "repair-result-too-large");
		Y.applyUpdate(doc, update, "server-file-repair");
		return Y.encodeStateAsUpdate(doc);
	} catch (error) {
		if (error instanceof FileRepairError) throw error;
		throw new FileRepairError(400, "invalid-local-update");
	} finally { trial.destroy(); }
}
