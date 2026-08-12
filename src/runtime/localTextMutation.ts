/**
 * Public local text-mutation API.
 *
 * Lets an external tool mutate a tracked file's CRDT (Y.Text) via a targeted
 * diff instead of writing the disk file directly. Because the write flows
 * through the CRDT and is flushed by DiskMirror (which registers a
 * self-write fingerprint), the resulting disk modify is recognized as
 * KAOS-originated and does NOT produce a superseded-candidate conflict
 * artifact — even when called in rapid succession, since successive calls
 * coalesce into a single CRDT-forward flush.
 *
 * This module is intentionally Obsidian-free so it can be imported in Node
 * regression tests; the plugin wires real {@link VaultSync.getTextForPath}
 * and {@link DiskMirror.scheduleWrite} via {@link LocalTextMutationDeps}.
 */

import type * as Y from "yjs";

import { applyDiffToYTextWithPostcondition, type DiffPostconditionResult } from "../sync/diff";
import { ORIGIN_LOCAL_TEXT_MUTATION } from "../sync/origins";

/**
 * Collaborators the pure mutation function needs. Kept minimal and structural
 * so the function is unit-testable without a Vault/DiskMirror.
 */
export interface LocalTextMutationDeps {
	/** Resolve the live Y.Text for a path, or null if the path is not tracked. */
	getTextForPath: (path: string) => Y.Text | null;
	/** Schedule a debounced disk flush for a path (DiskMirror.scheduleWrite). */
	scheduleWrite: (path: string) => void;
}

export interface LocalTextMutationResult {
	/** true iff the mutator returned different text and a CRDT diff was applied. */
	applied: boolean;
	/** Diff outcome when a mutation was applied; null for a no-op. */
	postcondition: DiffPostconditionResult | null;
}

/**
 * Apply a text mutation to a tracked file's CRDT.
 *
 * The mutator receives the current CRDT text (read fresh, synchronously) and
 * returns the desired next text. A targeted diff is applied under
 * {@link ORIGIN_LOCAL_TEXT_MUTATION} (a local-repair origin, so DiskMirror
 * observers will not auto-flush); the caller flushes explicitly via
 * {@link LocalTextMutationDeps.scheduleWrite}.
 *
 * The whole call is synchronous (read → mutator → diff → schedule), so there
 * is no event-loop interleaving and no lock is required. Concurrent editor
 * typing in unaffected regions is preserved by the CRDT merge; a stale base
 * is rebased and force-replaced as a last resort by the postcondition helper.
 *
 * @throws when the path is not tracked by the CRDT (no Y.Text resolved).
 */
export function applyLocalTextMutation(
	deps: LocalTextMutationDeps,
	path: string,
	mutator: (current: string) => string,
): LocalTextMutationResult {
	const ytext = deps.getTextForPath(path);
	if (!ytext) {
		throw new Error(`applyTextMutation: path not tracked by CRDT: ${path}`);
	}
	const current = ytext.toJSON();
	const next = mutator(current);
	if (next === current) {
		return { applied: false, postcondition: null };
	}
	const postcondition = applyDiffToYTextWithPostcondition(
		ytext,
		current,
		next,
		ORIGIN_LOCAL_TEXT_MUTATION,
	);
	deps.scheduleWrite(path);
	return { applied: true, postcondition };
}
