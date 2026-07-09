import { relative, resolve, sep } from "node:path";

export function normalizeVaultPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.split("/")
		.filter((part) => part.length > 0 && part !== ".")
		.join("/");
}

export function vaultPathToFsPath(vaultRoot: string, vaultPath: string): string {
	const root = resolve(vaultRoot);
	const target = resolve(root, ...normalizeVaultPath(vaultPath).split("/"));
	if (target !== root && !target.startsWith(`${root}${sep}`)) {
		throw new Error(`Path escapes vault root: ${vaultPath}`);
	}
	return target;
}

export function fsPathToVaultPath(vaultRoot: string, fsPath: string): string | null {
	const root = resolve(vaultRoot);
	const target = resolve(fsPath);
	const rel = relative(root, target);
	if (!rel || rel.startsWith("..") || rel === "..") return null;
	return normalizeVaultPath(rel);
}

export function isInternalHeadlessPath(path: string): boolean {
	const normalized = normalizeVaultPath(path);
	return normalized === ".kaos-headless" || normalized.startsWith(".kaos-headless/");
}
