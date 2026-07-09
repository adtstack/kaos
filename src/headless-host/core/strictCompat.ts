export type CompatMode = "strict" | "warn";

let compatMode: CompatMode = "strict";

export function setHeadlessCompatMode(mode: CompatMode): void {
	compatMode = mode;
}

export function unsupported(name: string): never {
	const message = `Headless Obsidian host does not implement ${name}`;
	if (compatMode === "warn") {
		console.warn(message);
		return undefined as never;
	}
	throw new Error(message);
}

