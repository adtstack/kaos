import * as Y from "yjs";
import type { VaultSyncSettings } from "../settings";
import type { BlobRef } from "../types";
import { cloneBlobRef, isSha256Hex } from "../types";
import { getDeviceAuthorizationHeader } from "./authHeader";
import { obsidianRequest } from "../utils/http";

export type ServerFileVersion = {
	protocol: 1; path: string; token: string; schema: number; oversized?: boolean;
} & (
	| { kind: "text"; fileId: string; content: string }
	| { kind: "blob"; ref: BlobRef }
	| { kind: "missing" }
	| { kind: "deleted" }
);

export class ServerFileClient {
	constructor(private readonly settings: VaultSyncSettings) {}
	private url(path: string): string {
		return `${this.settings.host.replace(/\/$/, "")}/vault/${encodeURIComponent(this.settings.vaultId)}/file-repair?path=${encodeURIComponent(path)}`;
	}
	async inspect(path: string): Promise<ServerFileVersion> {
		const result = await obsidianRequest({ url: this.url(path), method: "GET",
			headers: { Authorization: await getDeviceAuthorizationHeader(this.settings) } });
		if (result.status === 404) throw new Error("Server file repair requires an updated KAOS server.");
		if (result.status !== 200) throw new Error(`Server file query failed (${result.status}).`);
		const value = result.json as ServerFileVersion;
		if (!value || value.protocol !== 1 || value.path !== path || !isSha256Hex(value.token)
			|| !Number.isSafeInteger(value.schema) || value.schema < 1
			|| !["text", "blob", "missing", "deleted"].includes(value.kind)
			|| (value.kind === "text" && (typeof value.content !== "string" || typeof value.fileId !== "string"))
			|| (value.kind === "blob" && (!isSha256Hex(value.ref?.hash) || !Number.isSafeInteger(value.ref?.size) || value.ref.size < 0))) {
			throw new Error("Invalid server file response.");
		}
		return value.kind === "blob" ? { ...value, ref: cloneBlobRef(value.ref)! } : value;
	}
	async commit(version: ServerFileVersion, doc: Y.Doc): Promise<Uint8Array> {
		const bytes = Y.encodeStateAsUpdate(doc);
		if (bytes.length > 8 * 1024 * 1024) throw new Error("The local sync state exceeds the server file repair limit (8 MiB).");
		const result = await obsidianRequest({ url: this.url(version.path), method: "POST",
			headers: { Authorization: await getDeviceAuthorizationHeader(this.settings),
				"X-KAOS-Repair-Token": version.token, "Content-Type": "application/octet-stream" },
			body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
		if (result.status !== 200) {
			const reason = result.status === 409 ? "Server state changed. Review the server version again."
				: `Server file repair failed (${result.status}). Keep the safety backup and retry.`;
			throw new Error(reason);
		}
		if (result.headers["X-KAOS-File-Repair"] !== "1" && result.headers["x-kaos-file-repair"] !== "1") {
			throw new Error("Invalid server repair response.");
		}
		if (result.arrayBuffer.byteLength > 8 * 1024 * 1024) throw new Error("Server repair response exceeds the limit (8 MiB).");
		return new Uint8Array(result.arrayBuffer);
	}
}
