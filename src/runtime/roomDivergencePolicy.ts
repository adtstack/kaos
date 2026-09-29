/**
 * Room divergence policy — pure decision logic for post-reconcile health.
 *
 * Two silent-freeze failure modes look identical to a user ("sync does
 * nothing") but are distinguishable from counts both sides already have:
 *
 *   - stale-room-suspected: after a converged sync, the CRDT holds far
 *     FEWER files than the local vault. Typical cause: the device still
 *     points at an old vaultId room (copied data.json, re-onboarded server)
 *     and has finished syncing that smaller room — nothing is stuck, it is
 *     syncing the wrong room.
 *   - projection-stalled-suspected: after a converged sync and a completed
 *     reconcile, the CRDT holds far MORE files than local disk while the
 *     remote projection gate is closed. Downloads are frozen by the closed
 *     gate (invalid shared exclude policy, schema refusal), not by the
 *     network.
 *
 * Evaluated ONLY after a completed reconcile against converged state —
 * mid-download counts would false-positive both directions. A fresh device
 * joining an empty room never trips either signal (provider-synced with
 * crdt=0 is guarded, and small vaults are below the floor).
 *
 * Constraints (house style — see safetyBrakePolicy.ts):
 *   - Synchronous (no async)
 *   - No Obsidian imports
 *   - No disk I/O
 *   - No trace calls
 *   - No `this`
 *   - Pure: same inputs → same output
 */

/** Minimum local vault size before stale-room suspicion is meaningful. */
export const ROOM_DIVERGENCE_MIN_LOCAL_FILES = 200;
/** local/CRDT ratio at which the room is presumed stale. */
export const ROOM_DIVERGENCE_RATIO = 3;
/** Minimum CRDT-vs-disk gap before a projection stall is presumed. */
export const PROJECTION_STALL_MIN_GAP = 500;

export interface RoomDivergenceInput {
	/** True only after the provider finished its initial sync this session. */
	readonly providerSynced: boolean;
	/** Active CRDT markdown paths (vaultSync.getDebugSnapshot().activePathCount). */
	readonly crdtActivePathCount: number;
	/** Syncable markdown files currently on local disk. */
	readonly localSyncableFileCount: number;
	/** True when the remote projection gate is open for the current generation. */
	readonly projectionGateReady: boolean;
}

export type RoomDivergenceDecision =
	| { readonly kind: "ok" }
	| {
			readonly kind: "stale-room-suspected";
			readonly crdtActivePathCount: number;
			readonly localSyncableFileCount: number;
			readonly reason: string;
	  }
	| {
			readonly kind: "projection-stalled-suspected";
			readonly crdtActivePathCount: number;
			readonly localSyncableFileCount: number;
			readonly reason: string;
	  };

export function evaluateRoomDivergence(
	input: RoomDivergenceInput,
): RoomDivergenceDecision {
	if (!input.providerSynced) {
		return { kind: "ok" };
	}
	if (
		input.crdtActivePathCount > 0 &&
		input.localSyncableFileCount >= ROOM_DIVERGENCE_MIN_LOCAL_FILES &&
		input.localSyncableFileCount / input.crdtActivePathCount >= ROOM_DIVERGENCE_RATIO
	) {
		return {
			kind: "stale-room-suspected",
			crdtActivePathCount: input.crdtActivePathCount,
			localSyncableFileCount: input.localSyncableFileCount,
			reason:
				`this room holds ${input.crdtActivePathCount} synced files but this ` +
				`vault has ${input.localSyncableFileCount} — the device may be paired ` +
				`to a different or outdated room (vaultId)`,
		};
	}
	const missingOnDisk = input.crdtActivePathCount - input.localSyncableFileCount;
	if (missingOnDisk >= PROJECTION_STALL_MIN_GAP && !input.projectionGateReady) {
		return {
			kind: "projection-stalled-suspected",
			crdtActivePathCount: input.crdtActivePathCount,
			localSyncableFileCount: input.localSyncableFileCount,
			reason:
				`the room holds ${input.crdtActivePathCount} files but only ` +
				`${input.localSyncableFileCount} are on disk while remote projection ` +
				`is paused — downloads may be frozen by a closed shared policy gate`,
		};
	}
	return { kind: "ok" };
}
