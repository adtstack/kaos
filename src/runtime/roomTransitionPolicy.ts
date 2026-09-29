/**
 * Room transition policy — pure decision logic for host/vaultId changes.
 *
 * Pairing a device, claiming a server, or manually editing host/vaultId all
 * mutate the room identity while device-local state from the previous room
 * may still be live. This policy decides what must happen at that boundary:
 *
 *   - room-change (vaultId changed): the disk index and blob hash cache are
 *     claims about what the PREVIOUS room last settled. Applying them against
 *     a different room misclassifies every three-way decision, so room-scoped
 *     state must be reset before the first reconcile against the new room.
 *     The running sync runtime (constructed for the old room id) must also be
 *     restarted, or the plugin keeps syncing the old room after a successful
 *     pairing notice.
 *   - host-only (host changed, same vaultId): the same room continues on a
 *     new server; baselines remain valid. Restart the runtime only.
 *   - none: nothing changed (a re-pair to the same room keeps identity,
 *     auth, and baselines intact).
 *
 * Constraints (house style — see safetyBrakePolicy.ts):
 *   - Synchronous (no async)
 *   - No Obsidian imports
 *   - No disk I/O
 *   - No trace calls
 *   - No `this`
 *   - Pure: same inputs → same output
 */

export interface RoomIdentityChangeInput {
	/** Host URL before the settings mutation. */
	readonly previousHost: string;
	/** vaultId before the settings mutation. */
	readonly previousVaultId: string;
	/** Host URL after the settings mutation. */
	readonly nextHost: string;
	/** vaultId after the settings mutation. */
	readonly nextVaultId: string;
}

export type RoomTransitionDecision =
	| {
			readonly kind: "none";
	  }
	| {
			readonly kind: "host-only";
			readonly previousHost: string;
			readonly nextHost: string;
	  }
	| {
			readonly kind: "room-change";
			readonly resetRoomScopedState: true;
			readonly previousVaultId: string;
			readonly nextVaultId: string;
			readonly hostChanged: boolean;
	  };

/**
 * Evaluate what a host/vaultId settings change requires.
 *
 * An empty next host cannot sync; leave all state untouched (the unsynced
 * state machinery handles that case) rather than resetting room-scoped state
 * for a room the device cannot even address. A fully unconfigured device
 * gaining its first identity (both fields empty before) is initial
 * configuration, not a transition — startup vaultId/deviceName generation
 * must not fire a reset or restart.
 */
export function evaluateRoomIdentityTransition(
	input: RoomIdentityChangeInput,
): RoomTransitionDecision {
	const hostChanged = input.nextHost !== input.previousHost;
	const vaultIdChanged = input.nextVaultId !== input.previousVaultId;
	if (!hostChanged && !vaultIdChanged) {
		return { kind: "none" };
	}
	if (input.nextHost.trim() === "") {
		return { kind: "none" };
	}
	if (input.previousHost === "" && input.previousVaultId === "") {
		return { kind: "none" };
	}
	if (vaultIdChanged) {
		return {
			kind: "room-change",
			resetRoomScopedState: true,
			previousVaultId: input.previousVaultId,
			nextVaultId: input.nextVaultId,
			hostChanged,
		};
	}
	return {
		kind: "host-only",
		previousHost: input.previousHost,
		nextHost: input.nextHost,
	};
}
