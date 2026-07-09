import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class HeadlessPluginStorage<T = unknown> {
	constructor(readonly dataFile: string) {}

	async load(): Promise<T | null> {
		try {
			return JSON.parse(await readFile(this.dataFile, "utf8")) as T;
		} catch {
			return null;
		}
	}

	async save(data: T): Promise<void> {
		await mkdir(dirname(this.dataFile), { recursive: true });
		const tmp = `${this.dataFile}.tmp`;
		await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		await rename(tmp, this.dataFile);
	}
}

