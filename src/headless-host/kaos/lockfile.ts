import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface HeadlessHostLockfileMetadata {
	vaultRoot?: string;
	dataFile?: string;
}

export class HeadlessHostLockfile {
	private handle: FileHandle | null = null;

	constructor(
		readonly path: string,
		private readonly metadata: HeadlessHostLockfileMetadata = {},
	) {}

	async acquire(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		try {
			this.handle = await open(this.path, "wx");
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code === "EEXIST") {
				throw new Error(`headless host lock already exists: ${this.path}`);
			}
			throw err;
		}
		await this.handle.writeFile(JSON.stringify({
			pid: process.pid,
			hostname: hostname(),
			startedAt: new Date().toISOString(),
			runtime: "kaos-headless-host",
			...this.metadata,
		}, null, 2));
	}

	async release(): Promise<void> {
		const handle = this.handle;
		this.handle = null;
		if (handle) await handle.close();
		await rm(this.path, { force: true });
	}
}
