import { getServerByName } from "partyserver";
import {
	applyRecoveryRetention,
	auditRecoveryStorage,
	getRecoveryContent,
	getRecoveryManifest,
	listRecoveryManifestIndexes,
	type RecoveryStorageAuditReport,
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

export function recoverySnapshotMaybeTraceEventName(status: RecoverySnapshotResult["status"]): string {
	if (status === "created") return "recovery-snapshot-created";
	if (status === "pending") return "recovery-snapshot-pending";
	if (status === "noop") return "recovery-snapshot-skipped";
	return "recovery-snapshot-unavailable";
}

function unavailableRecoveryStorageReport(): RecoveryStorageAuditReport {
	return {
		status: "unavailable",
		checkedAt: new Date().toISOString(),
		latestManifestId: null,
		latestIndexManifestId: null,
		latestStateManifestId: null,
		manifestCount: 0,
		manifestCountLowerBound: 0,
		checkedManifestCount: 0,
		issues: [{
			kind: "storage-unavailable",
			severity: "error",
			message: "File history storage is unavailable.",
			repairable: false,
			repaired: false,
		}],
		repairs: [],
		contentCheckLimited: false,
	};
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
		await options.recordVaultTrace(env, vaultId, recoverySnapshotMaybeTraceEventName(result.status), {
			status: result.status,
			manifestId: result.manifestId,
			triggeredBy: body.device,
			forceFull: body.forceFull === true,
			reason: result.reason,
			changedCount: result.index?.changedCount,
			fileHistoryKind: result.index?.kind,
			uploadedContentCount: result.pending?.uploadedContentCount,
			totalContentCount: result.pending?.totalContentCount,
			remainingContentCount: result.pending?.remainingContentCount,
		});
		return json({ ...result, pendingUpload: undefined });
	}

	if (req.method === "GET" && rest.length === 1 && rest[0] === "status") {
		const bucket = env.KAOS_BUCKET;
		if (!bucket) {
			return json(unavailableRecoveryStorageReport(), 503);
		}
		const result = await auditRecoveryStorage(vaultId, bucket, {
			repair: false,
			manifestCheckLimit: 0,
			contentCheckLimit: 0,
		});
		return json(result, result.status === "unavailable" ? 503 : 200);
	}

	if (req.method === "POST" && rest.length === 1 && rest[0] === "repair") {
		const bucket = env.KAOS_BUCKET;
		if (!bucket) {
			return json(unavailableRecoveryStorageReport(), 503);
		}
		const result = await auditRecoveryStorage(vaultId, bucket, { repair: true });
		if (result.repairs.some((repair) => repair.success)) {
			await options.recordVaultTrace(env, vaultId, "recovery-storage-repaired", {
				status: result.status,
				latestManifestId: result.latestManifestId,
				repairCount: result.repairs.filter((repair) => repair.success).length,
				issueCount: result.issues.length,
			});
		}
		if (result.status === "degraded") {
			await options.recordVaultTrace(env, vaultId, "recovery-storage-degraded", {
				status: result.status,
				latestManifestId: result.latestManifestId,
				issueCount: result.issues.length,
				unrepairedIssueKinds: result.issues
					.filter((issue) => !issue.repaired)
					.map((issue) => issue.kind)
					.slice(0, 20),
			});
		}
		return json(result, result.status === "unavailable" ? 503 : 200);
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
