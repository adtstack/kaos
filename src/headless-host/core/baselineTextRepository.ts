import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HASH_RE = /^[a-f0-9]{64}$/i;

/** Filesystem-backed content-addressed baseline storage for the headless host. */
export class HeadlessBaselineTextRepository {
	private tempSequence = 0;

	constructor(readonly rootDir: string) {}

	async load(hashes: Iterable<string>): Promise<Record<string, string>> {
		const output: Record<string, string> = {};
		for (const hash of new Set(hashes)) {
			if (!HASH_RE.test(hash)) continue;
			try {
				output[hash] = await readFile(join(this.rootDir, hash.toLowerCase()), "utf8");
			} catch {
				// Missing/corrupt entries are a safe no-base fallback for the plugin.
			}
		}
		return output;
	}

	async save(entries: Record<string, string>): Promise<void> {
		const validEntries = Object.entries(entries).filter(([hash, text]) =>
			HASH_RE.test(hash) && typeof text === "string");
		if (validEntries.length === 0) {
			await mkdir(this.rootDir, { recursive: true });
			return;
		}
		await mkdir(this.rootDir, { recursive: true });
		for (const [hash, text] of validEntries) {
			const target = join(this.rootDir, hash.toLowerCase());
			this.tempSequence = (this.tempSequence + 1) % Number.MAX_SAFE_INTEGER;
			const tmp = `${target}.${process.pid}.${Date.now()}.${this.tempSequence}.tmp`;
			await writeFile(tmp, text, "utf8");
			await rename(tmp, target);
		}
	}

	async retain(hashes: Iterable<string>): Promise<void> {
		const keep = new Set(Array.from(hashes).filter((hash) => HASH_RE.test(hash)).map((hash) => hash.toLowerCase()));
		let names: string[];
		try {
			names = await readdir(this.rootDir);
		} catch (err) {
			if (isMissingFileError(err)) return;
			throw err;
		}
		for (const name of names) {
			if (!HASH_RE.test(name) || keep.has(name.toLowerCase())) continue;
			try {
				await unlink(join(this.rootDir, name));
			} catch (err) {
				if (!isMissingFileError(err)) throw err;
			}
		}
	}

	async remove(hashes: Iterable<string>): Promise<void> {
		for (const hash of new Set(hashes)) {
			if (!HASH_RE.test(hash)) continue;
			try {
				await unlink(join(this.rootDir, hash.toLowerCase()));
			} catch (err) {
				if (!isMissingFileError(err)) throw err;
			}
		}
	}
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error
		&& (error as { code?: unknown }).code === "ENOENT";
}
