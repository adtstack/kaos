/**
 * KAOS CRDT schema version constant.
 *
 * This module is intentionally Obsidian-free so it can be imported
 * in Node regression tests and server code without the Obsidian dependency.
 *
 * Schema versioning semantics:
 *   v1 — legacy path model (pathToId authoritative)
 *   v2 — id-first model (meta.path authoritative), flat JSON metadata values
 *   v3 — nested Y.Map metadata (field-level CRDT), lazy on-write migration
 *   v4 — causal attachment refs and self-contained delete authority
 *
 * markdownPathRetirements keeps one last move keyed by file ID (including
 * oldPath), not an ever-growing record per old path. Older paths are checked
 * against existing file history before automatic file creation. It is an
 * optional additive map under v4. Existing
 * document encodings remain readable; honoring its removal policy requires
 * updating every client that writes to the vault.
 *
 * Bump this constant and SERVER_MAX_SCHEMA_VERSION in server/src/version.ts
 * whenever a breaking schema change ships. Keep SERVER_MIN_SCHEMA_VERSION at
 * the oldest schema the server can still safely admit during rolling upgrades.
 */
export const SCHEMA_VERSION = 4;
