/**
 * Read-skip policy — pure decision logic for authoritative reconcile reads.
 *
 * The authoritative reconcile branch historically read EVERY eligible file on
 * EVERY startup (reconciliationController's `changed = eligibleFiles`), even
 * when nothing changed anywhere. On large vaults this dominates mobile cold
 * start. This policy decides when a file's disk read can be skipped.
 *
 * A read may be skipped only when all three proofs hold:
 *
 *   1. statMatchesIndex — the file's mtime/size equal the disk-index entry,
 *      so the disk bytes cannot have changed since the entry was written
 *      (external editors update mtime; content-preserving touch is not a
 *      threat model for authority decisions).
 *   2. baselineHash present — the index entry carries a contentHash, which
 *      is written only on a CLEAN settlement (see diskIndex.ts: contentHash
 *      means "disk and CRDT agreed on exactly this content at settle time").
 *   3. crdtHash === baselineHash — the live CRDT text still hashes to that
 *      settlement baseline, so the CRDT side has not advanced either.
 *
 * Together: disk == baseline == CRDT. No three-way authority decision can
 * depend on bytes that are provably equal on both sides, so not reading them
 * cannot change any outcome — the file is a no-op for this reconcile pass,
 * exactly like a stat-matching file in conservative mode.
 *
 * Anything failing a condition MUST be read (conservative fallback): a
 * missing baseline (first run, or never cleanly settled), a stat change
 * (possible external edit), or CRDT divergence (remote change to flush).
 *
 * Mid-reconcile CRDT advancement after a skip decision is not a regression:
 * remote changes reach disk through the DiskMirror observer projection lane,
 * and the next reconcile re-evaluates the (now failing) hash condition.
 *
 * Constraints (house style — see safetyBrakePolicy.ts):
 *   - Synchronous (no async)
 *   - No Obsidian imports
 *   - No disk I/O
 *   - No trace calls
 *   - No `this`
 *   - Pure: same inputs → same output
 */

export interface ReadSkipInput {
	/** True when the file's current stat equals the disk-index entry's stat. */
	readonly statMatchesIndex: boolean;
	/**
	 * Clean-settlement baseline hash from the disk index, or null when the
	 * entry carries no contentHash (never cleanly settled).
	 */
	readonly baselineHash: string | null;
	/** SHA-256 of the live CRDT text, or null when the path has no CRDT text. */
	readonly crdtHash: string | null;
}

/**
 * Decide whether an authoritative reconcile may skip reading this file.
 * Callers must have already computed the hashes; this function only makes
 * the comparison legitimate and testable in isolation.
 */
export function shouldSkipDiskRead(input: ReadSkipInput): boolean {
	return (
		input.statMatchesIndex &&
		input.baselineHash !== null &&
		input.crdtHash !== null &&
		input.crdtHash === input.baselineHash
	);
}
