import { getServerByName } from "partyserver";
import {
	applyRecoveryRetention,
	getRecoveryContent,
	getRecoveryManifest,
	listRecoveryManifestIndexes,
	type RecoverySnapshotResult,
} from "../recoverySnapshot";
import type { Env, JsonResponse } from "./types";

interface RecoverySnapshotRouteOptions {
	recordVaultTrace(
		env: Env,
		vaultId: string,
		event: string,
		data?: Record<string, unknown>,
	): Promise<void>;
}

export async function handleRecoverySnapshotRoute(
	env: Env,
	vaultId: string,
	req: Request,
	rest: string[],
	json: JsonResponse,
	options: RecoverySnapshotRouteOptions,
): Promise<Response> {
	if (req.method === "POST" && rest.length === 1 && rest[0] === "maybe") {
		let body: { device?: string; forceFull?: boolean } = {};
		try {
			body = await req.json();
		} catch {
			body = {};
		}

		const stub = await getServerByName(env.KAOS_SYNC, vaultId);
		const res = await stub.fetch("https://internal/__kaos/recovery-snapshot-maybe", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		const text = await res.text();
		if (!res.ok) {
			return new Response(text || JSON.stringify({ error: "recovery_snapshot_failed" }), {
				status: res.status,
				headers: {
					"Content-Type": res.headers.get("Content-Type") ?? "application/json; charset=utf-8",
					"Cache-Control": "no-store",
				},
			});
		}
		const result: RecoverySnapshotResult = JSON.parse(text) as RecoverySnapshotResult;
		await options.recordVaultTrace(env, vaultId, "recovery-snapshot-created", {
			status: result.status,
			manifestId: result.manifestId,
			triggeredBy: body.device,
			forceFull: body.forceFull === true,
		});
		return json(result);
	}

	if (req.method === "POST" && rest.length === 1 && rest[0] === "prune") {
		const bucket = env.KAOS_BUCKET;
		if (!bucket) {
			return json({ error: "recovery_snapshots_unavailable" }, 503);
		}
		const result = await applyRecoveryRetention(vaultId, bucket);
		await options.recordVaultTrace(env, vaultId, "recovery-retention-applied", {
			kept: result.kept,
			prunedManifests: result.prunedManifests,
			contentDeleted: result.contentDeleted,
			failed: result.failed,
			errors: result.errors.slice(0, 10),
		});
		return json(result);
	}

	if (req.method === "GET" && rest.length === 0) {
		const bucket = env.KAOS_BUCKET;
		if (!bucket) {
			return json({ error: "recovery_snapshots_unavailable" }, 503);
		}

		const url = new URL(req.url);
		const limitParam = url.searchParams.get("limit");
		const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200) : 50;
		const result = await listRecoveryManifestIndexes(vaultId, bucket, limit);
		return json(result);
	}

	if (req.method === "GET" && rest.length === 2 && rest[1] === "manifest") {
		const bucket = env.KAOS_BUCKET;
		if (!bucket) {
			return json({ error: "recovery_snapshots_unavailable" }, 503);
		}
		const manifest = await getRecoveryManifest(vaultId, rest[0] ?? "", bucket);
		if (!manifest) {
			return json({ error: "not found" }, 404);
		}
		return json(manifest);
	}

	return json({ error: "not found" }, 404);
}

export async function handleRecoveryContentRoute(
	env: Env,
	vaultId: string,
	req: Request,
	rest: string[],
	json: JsonResponse,
): Promise<Response> {
	if (req.method !== "GET" || rest.length !== 1) {
		return json({ error: "not found" }, 404);
	}
	const bucket = env.KAOS_BUCKET;
	if (!bucket) {
		return json({ error: "recovery_snapshots_unavailable" }, 503);
	}

	try {
		const result = await getRecoveryContent(vaultId, rest[0] ?? "", bucket);
		if (!result) {
			return json({ error: "not found" }, 404);
		}
		return new Response(result.compressedBytes, {
			headers: {
				"Content-Type": "application/gzip",
				"Cache-Control": "no-store",
			},
		});
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
}
