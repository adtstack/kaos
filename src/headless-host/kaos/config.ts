import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface KaosHeadlessConfigPatch {
	host?: string;
	vaultId?: string;
	deviceName?: string;
	deviceId?: string;
	identityFile?: string;
	enableAttachmentSync?: boolean;
}

export async function mergeKaosHeadlessConfig(dataFile: string, patch: KaosHeadlessConfigPatch): Promise<void> {
	const effectivePatch = {
		...patch,
		...(patch.enableAttachmentSync !== undefined && { attachmentSyncExplicitlyConfigured: true }),
	};
	const entries = Object.entries(effectivePatch).filter(([, value]) => value !== undefined);
	if (entries.length === 0) return;
	const existing = await readExistingData(dataFile);
	const next = mergeConfigPatch(existing, patch);
	await mkdir(dirname(dataFile), { recursive: true });
	const tmp = `${dataFile}.kaos-headless-config-${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	await rename(tmp, dataFile);
}

export async function readKaosHeadlessData(dataFile: string): Promise<Record<string, unknown>> {
	return await readExistingData(dataFile);
}

export function mergeConfigPatch(data: Record<string, unknown>, patch: KaosHeadlessConfigPatch): Record<string, unknown> {
	const effectivePatch = {
		...patch,
		...(patch.enableAttachmentSync !== undefined && { attachmentSyncExplicitlyConfigured: true }),
	};
	const next = {
		...data,
		...Object.fromEntries(Object.entries(effectivePatch).filter(([, value]) => value !== undefined)),
	};
	// Older headless data.json files may contain the shared token.  Configuration
	// now records only an identity path and public device ID.
	delete next.token;
	return next;
}

async function readExistingData(dataFile: string): Promise<Record<string, unknown>> {
	try {
		const value = JSON.parse(await readFile(dataFile, "utf8"));
		return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
	} catch {
		return {};
	}
}
