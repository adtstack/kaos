import { compareSemver } from "../utils/semver";

export type GuidedServerUpdateStatus = "idle" | "waiting-for-user" | "waiting-for-deploy" | "updated" | "timed-out";

export type PersistedGuidedServerUpdateState = {
	status: Exclude<GuidedServerUpdateStatus, "idle">;
	targetVersion: string;
	startedAt: number;
	updateActionUrl: string;
};

export const GUIDED_SERVER_UPDATE_USER_ACTION_GRACE_MS = 2 * 60 * 1000;
export const GUIDED_SERVER_UPDATE_TIMEOUT_MS = 30 * 60 * 1000;

export function readPersistedGuidedServerUpdateState(value: unknown): PersistedGuidedServerUpdateState | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as {
		status?: unknown;
		targetVersion?: unknown;
		startedAt?: unknown;
		updateActionUrl?: unknown;
	};
	if (
		candidate.status !== "waiting-for-user" &&
		candidate.status !== "waiting-for-deploy" &&
		candidate.status !== "updated" &&
		candidate.status !== "timed-out"
	) {
		return null;
	}
	if (typeof candidate.targetVersion !== "string" || candidate.targetVersion.trim().length === 0) {
		return null;
	}
	if (
		typeof candidate.startedAt !== "number" ||
		!Number.isFinite(candidate.startedAt) ||
		candidate.startedAt <= 0
	) {
		return null;
	}
	if (typeof candidate.updateActionUrl !== "string" || candidate.updateActionUrl.trim().length === 0) {
		return null;
	}
	return {
		status: candidate.status,
		targetVersion: candidate.targetVersion,
		startedAt: candidate.startedAt,
		updateActionUrl: candidate.updateActionUrl,
	};
}

export function evaluateGuidedServerUpdateState(
	state: PersistedGuidedServerUpdateState | null,
	serverVersion: string | null,
	now = Date.now(),
): {
	status: GuidedServerUpdateStatus;
	state: PersistedGuidedServerUpdateState | null;
	changed: boolean;
} {
	if (!state) {
		return { status: "idle", state: null, changed: false };
	}

	const reachedTarget = serverVersion !== null &&
		(compareSemver(serverVersion, state.targetVersion) ?? -1) >= 0;
	let nextStatus: PersistedGuidedServerUpdateState["status"] = state.status;
	if (reachedTarget) {
		nextStatus = "updated";
	} else if (now - state.startedAt >= GUIDED_SERVER_UPDATE_TIMEOUT_MS) {
		nextStatus = "timed-out";
	} else if (
		state.status === "waiting-for-user" &&
		now - state.startedAt >= GUIDED_SERVER_UPDATE_USER_ACTION_GRACE_MS
	) {
		nextStatus = "waiting-for-deploy";
	}

	if (nextStatus === state.status) {
		return { status: nextStatus, state, changed: false };
	}
	return {
		status: nextStatus,
		state: {
			...state,
			status: nextStatus,
		},
		changed: true,
	};
}
