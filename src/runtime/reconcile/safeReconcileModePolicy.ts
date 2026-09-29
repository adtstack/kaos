/**
 * Safe reconcile mode policy — pure decision logic for gating an
 * authoritative reconciliation pass on local Yjs replica completeness.
 *
 * An authoritative pass projects CRDT content onto disk and into open
 * editors. While the local IndexedDB-backed replica is still hydrating, the
 * in-memory doc holds only what the server sent. When the server room is
 * behind this device's newest operations (app killed before upload, stale
 * room, server rollback), every three-way "disk at baseline, CRDT differs"
 * decision trusts the CRDT side as newer — and the pass visibly reverts
 * notes to the older server state. The same rule fires even after hydration
 * when the local cache itself lost tail operations, which is why callers
 * must treat a not-yet-hydrated replica as "CRDT side unknown" rather than
 * "CRDT side authoritative".
 *
 * Provider sync alone is therefore NOT sufficient authority: the pass
 * requires localReady. A device whose IndexedDB never loads — or which
 * latched an idbError, even after an earlier successful sync — stays
 * conservative (fail-closed): additive creates and blob downloads continue,
 * destructive projection waits. Users can escape via the explicit
 * force-authoritative command.
 *
 * Constraints (house style — see safetyBrakePolicy.ts):
 *  - Synchronous (no async)
 *  - No Obsidian imports
 *  - No Yjs imports
 *  - No disk I/O
 *  - No trace calls
 *  - No `this`
 *  - Pure: same inputs → same output
 */
import type { ReconcileMode } from "../../sync/vaultSync";

export interface SafeReconcileModeInput {
	/** True once the websocket provider completed its first room sync. */
	readonly providerSynced: boolean;
	/** True once the local IndexedDB-backed Y.Doc finished hydrating. */
	readonly localReady: boolean;
	/**
	 * True once IndexedDB latched an error. Fail-closed: an idbError device
	 * stays conservative even if `synced` fired before the error — the error
	 * may have corrupted the persistence the doc state depends on, and blob
	 * upload authority already requires !idbError. Only the explicit manual
	 * override ({@link forceUnhydrated}) escapes.
	 */
	readonly idbError?: boolean;
	/** True once the room's `initialized` sentinel is set. */
	readonly initialized: boolean;
	/** True once the room's `schemaVersion` sentinel is present. */
	readonly schemaVersionKnown: boolean;
}

export function decideSafeReconcileMode(
	input: SafeReconcileModeInput,
): ReconcileMode {
	if (!input.localReady || input.idbError === true) return "conservative";
	if (input.providerSynced) return "authoritative";
	if (input.initialized && input.schemaVersionKnown) return "authoritative";
	return "conservative";
}
