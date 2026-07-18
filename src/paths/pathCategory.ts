/**
 * Path category classification — the single place that determines whether
 * a vault path is a CRDT text document, blob, or excluded.
 *
 * Delegates to existing product policy (isExcluded, extension checks) but
 * operates on canonicalized paths to ensure NFC/NFD-equivalent paths get
 * the same category.
 *
 * IMPORTANT: classifySyncPath uses the same logic as the existing
 * isMarkdownSyncable/isBlobSyncable functions. It does not invent new
 * blob eligibility rules.
 */

import { canonicalizeVaultPath, type CanonicalPath } from "./canonicalPath";
import { isExcluded } from "../sync/exclude";
import {
	isLocalSafetyArtifactPath,
	isMarkdownConflictArtifactPath,
} from "./conflictArtifactPath";
import { isCrdtDocumentPath } from "./crdtDocumentPath";

export type PathSyncCategory =
	// `markdown` is the legacy wire/runtime label for all CRDT text documents,
	// including Obsidian Bases (`.base`).
	| { kind: "markdown"; path: CanonicalPath }
	| { kind: "blob"; path: CanonicalPath }
	| { kind: "excluded"; path: CanonicalPath; reason: string };

/**
 * Classify a vault-relative path into its sync category.
 *
 * Uses the same rules as existing isMarkdownSyncable / isBlobSyncable:
 *   1. Excluded paths (config dir, .trash, user patterns) are always excluded.
 *   2. KAOS markdown/blob conflict and local-backup artifacts are excluded
 *      local-only safety copies.
 *   3. `.md` and `.base` files that are not excluded are CRDT documents.
 *   4. Other files that are not excluded are blobs.
 *
 * This matches the existing isMarkdownSyncable/isBlobSyncable contracts,
 * including their durable local-safety-artifact subtree exclusions.
 */
export function classifySyncPath(input: {
	path: string;
	excludePatterns: readonly string[];
	configDir: string;
}): PathSyncCategory {
	const canonical = canonicalizeVaultPath(input.path);

	// Exclusion check uses normalizedPath (NFC + separator-cleaned).
	// isExcluded already does its own prefix normalization internally,
	// but we pass the cleaned form for consistency.
	if (isExcluded(canonical.normalizedPath, [...input.excludePatterns], input.configDir)) {
		return { kind: "excluded", path: canonical, reason: "excluded-by-pattern" };
	}

	// Preserve the legacy reason for a Markdown conflict artifact itself. The
	// shared predicate below additionally catches every artifact subtree.
	if (isMarkdownConflictArtifactPath(canonical.normalizedPath)) {
		return { kind: "excluded", path: canonical, reason: "excluded-by-pattern" };
	}
	if (isLocalSafetyArtifactPath(canonical.normalizedPath)) {
		return { kind: "excluded", path: canonical, reason: "local-safety-artifact" };
	}

	// Text-document check on normalized path (same as isMarkdownSyncable).
	if (isCrdtDocumentPath(canonical.normalizedPath)) {
		return { kind: "markdown", path: canonical };
	}

	// Non-document, non-excluded, non-artifact = blob-syncable.
	return { kind: "blob", path: canonical };
}
