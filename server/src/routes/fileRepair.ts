import { fetchVaultRoomCheap } from "./trace";
import { FileRepairError, MAX_FILE_REPAIR_BYTES, validateRepairPath } from "../fileRepair";
import type { Env } from "./types";
import { json } from "./http";

export async function readRepairBody(request: Request): Promise<Uint8Array> {
	const reader = request.body?.getReader();
	if (!reader) throw new FileRepairError(400, "missing-local-update");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			const value: unknown = next.value;
			if (!(value instanceof Uint8Array)) throw new FileRepairError(400, "invalid-body-chunk");
			size += value.length;
			if (size > MAX_FILE_REPAIR_BYTES) {
				await reader.cancel();
				throw new FileRepairError(413, "repair-update-too-large");
			}
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	return bytes;
}

/** Called only after the worker's device authorization check. */
export async function handleFileRepairRoute(env: Env, vaultId: string, request: Request): Promise<Response> {
	try {
		const path = validateRepairPath(new URL(request.url).searchParams.get("path"));
		const token = request.headers.get("X-KAOS-Repair-Token");
		if (request.method === "POST" && (!token || !/^[a-f0-9]{64}$/.test(token))) {
			throw new FileRepairError(400, "invalid-repair-token");
		}
		const body = request.method === "POST" ? await readRepairBody(request) : undefined;
		return await fetchVaultRoomCheap(env, vaultId, `/__kaos/file-repair?path=${encodeURIComponent(path)}`, {
			method: request.method,
			headers: token ? { "X-KAOS-Repair-Token": token } : {},
			body,
		});
	} catch (error) {
		return json({ error: error instanceof FileRepairError ? error.message : "server-file-unavailable" },
			error instanceof FileRepairError ? error.status : 503);
	}
}
