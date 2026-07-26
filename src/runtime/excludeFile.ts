import {
	KAOS_EXCLUDE_FILE_PATH,
	parseKaosExcludeFile,
} from "../sync/exclude";

export const KAOS_EXCLUDE_FILE_MAX_CHARS = 64 * 1024;

export interface ExcludeFileAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
}

export interface KaosExcludeFileSnapshot {
	present: boolean;
	raw: string | null;
	patterns: string[];
}

export interface KaosExcludeCrdtSource {
	getActiveFileIdsForPath(path: string): string[];
	getTextForPath(path: string): { toJSON(): unknown } | null;
}

function parseKaosExcludeSnapshot(raw: string): KaosExcludeFileSnapshot {
	if (raw.length > KAOS_EXCLUDE_FILE_MAX_CHARS) {
		throw new Error(
			`${KAOS_EXCLUDE_FILE_PATH} exceeds the ${KAOS_EXCLUDE_FILE_MAX_CHARS}-character safety limit`,
		);
	}
	return {
		present: true,
		raw,
		patterns: parseKaosExcludeFile(raw),
	};
}

/** Read and parse the vault-shared exclude control file without mutating it. */
export async function readKaosExcludeFile(
	adapter: ExcludeFileAdapter,
): Promise<KaosExcludeFileSnapshot> {
	if (!await adapter.exists(KAOS_EXCLUDE_FILE_PATH)) {
		return { present: false, raw: null, patterns: [] };
	}
	const raw = await adapter.read(KAOS_EXCLUDE_FILE_PATH);
	return parseKaosExcludeSnapshot(raw);
}

/**
 * Read the shared exclude control file from one already-converged Y.Doc.
 *
 * Path ambiguity and missing content are invalid authority states. Callers
 * must keep ordinary remote projection closed instead of substituting an empty
 * policy.
 */
export function readKaosExcludeFileFromCrdt(
	source: KaosExcludeCrdtSource,
): KaosExcludeFileSnapshot {
	const activeFileIds = source.getActiveFileIdsForPath(KAOS_EXCLUDE_FILE_PATH);
	if (activeFileIds.length === 0) {
		return { present: false, raw: null, patterns: [] };
	}
	if (activeFileIds.length !== 1) {
		throw new Error(
			`${KAOS_EXCLUDE_FILE_PATH} has an ambiguous CRDT path binding`,
		);
	}

	const ytext = source.getTextForPath(KAOS_EXCLUDE_FILE_PATH);
	if (!ytext) {
		throw new Error(
			`${KAOS_EXCLUDE_FILE_PATH} has an active CRDT path without Y.Text`,
		);
	}
	const raw = ytext.toJSON();
	if (typeof raw !== "string") {
		throw new Error(
			`${KAOS_EXCLUDE_FILE_PATH} CRDT Y.Text returned non-text content`,
		);
	}
	return parseKaosExcludeSnapshot(raw);
}
