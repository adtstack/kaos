import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface HeadlessPathState {
	fileId?: string;
	contentHash: string;
	crdtHash: string;
	mtime: number;
	size: number;
	updatedAt: number;
	renamedTo?: string;
}

export interface HeadlessState {
	version: 1;
	deviceName: string;
	vaultId: string;
	paths: Record<string, HeadlessPathState>;
	lastReconcileAt: number | null;
}

export function createEmptyHeadlessState(deviceName: string, vaultId: string): HeadlessState {
	return {
		version: 1,
		deviceName,
		vaultId,
		paths: {},
		lastReconcileAt: null,
	};
}

export class JsonHeadlessStateStore {
	constructor(
		readonly path: string,
		private readonly deviceName: string,
		private readonly vaultId: string,
	) {}

	async load(): Promise<HeadlessState> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
			if (isHeadlessState(parsed)) {
				return {
					...parsed,
					deviceName: parsed.deviceName || this.deviceName,
					vaultId: parsed.vaultId || this.vaultId,
				};
			}
		} catch {
			// Missing or invalid state starts fresh. Reconcile remains fail-safe
			// because missing baselines are treated as conflicts, not clean overwrites.
		}
		return createEmptyHeadlessState(this.deviceName, this.vaultId);
	}

	async save(state: HeadlessState): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp`;
		await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		await rename(tmp, this.path);
	}
}

function isHeadlessState(value: unknown): value is HeadlessState {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (record.version !== 1) return false;
	if (typeof record.deviceName !== "string") return false;
	if (typeof record.vaultId !== "string") return false;
	if (typeof record.paths !== "object" || record.paths === null || Array.isArray(record.paths)) {
		return false;
	}
	return true;
}
