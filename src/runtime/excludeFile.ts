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

/** Read and parse the vault-shared exclude control file without mutating it. */
export async function readKaosExcludeFile(
	adapter: ExcludeFileAdapter,
): Promise<KaosExcludeFileSnapshot> {
	if (!await adapter.exists(KAOS_EXCLUDE_FILE_PATH)) {
		return { present: false, raw: null, patterns: [] };
	}
	const raw = await adapter.read(KAOS_EXCLUDE_FILE_PATH);
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
