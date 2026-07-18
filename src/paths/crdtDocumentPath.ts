/**
 * Text documents synchronized through the Y.Text/CRDT lane.
 *
 * `.base` files are Obsidian Bases documents (YAML text), not attachments.
 * Keeping this policy in one helper prevents them from falling back into the
 * blob lane, where replacement uses visible-file backup renames.
 */
export const CRDT_DOCUMENT_SUFFIXES = [".md", ".base"] as const;

export type CrdtDocumentSuffix = (typeof CRDT_DOCUMENT_SUFFIXES)[number];

export function getCrdtDocumentSuffix(path: string): CrdtDocumentSuffix | null {
	for (const suffix of CRDT_DOCUMENT_SUFFIXES) {
		if (path.endsWith(suffix)) return suffix;
	}
	return null;
}

export function isCrdtDocumentPath(path: string): boolean {
	return getCrdtDocumentSuffix(path) !== null;
}
