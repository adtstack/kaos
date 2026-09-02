import type { VaultSyncServer } from "../server";
import type { StoredServerConfig } from "../config";

export interface Env {
	/**
	 * Break-glass bootstrap secret. It is compared only while no rotated
	 * recovery verifier has been stored in KAOS_CONFIG and is never used for
	 * routine sync authentication.
	 */
	KAOS_RECOVERY_SECRET?: string;
	/**
	 * Deploy-time proof required to claim an otherwise unclaimed server.
	 * This is separate from the generated sync token and is never persisted in
	 * the Config Durable Object or returned to a client.
	 */
	KAOS_CLAIM_SECRET?: string;
	KAOS_CANONICAL_REPO?: string;
	KAOS_SYNC: DurableObjectNamespace<VaultSyncServer>;
	KAOS_CONFIG: DurableObjectNamespace;
	KAOS_BUCKET?: R2Bucket;
}

export type JsonResponse = (body: unknown, status?: number) => Response;

/**
 * Legacy claim state. Kept only for server setup and the one-way, seven-day
 * migration enrollment window; it is not a vault authorization principal.
 */
export type AuthState =
	| { mode: "device"; claimed: true; config?: StoredServerConfig }
	| { mode: "unclaimed"; claimed: false; config?: StoredServerConfig };

/**
 * A request-scoped auth state that carries the full Config Durable Object
 * value. It is not a module cache: each Worker request obtains current state
 * from the authoritative Durable Object.
 */
export type AuthStateWithConfig =
	| { mode: "device"; claimed: true; config: StoredServerConfig }
	| { mode: "unclaimed"; claimed: false; config: StoredServerConfig };

export type FatalAuthCode = "unauthorized" | "server_misconfigured" | "unclaimed" | "update_required";

export type UpdateProvider = "github" | "gitlab" | "unknown";
