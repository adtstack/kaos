import { basename, dirname, extname } from "node:path";

export interface HeadlessFileStats {
	ctime: number;
	mtime: number;
	size: number;
}

export abstract class TAbstractFile {
	vault: unknown;
	path: string;
	name: string;
	parent: TFolder | null;

	constructor(path: string, parent: TFolder | null = null) {
		this.path = normalizePath(path);
		this.name = basename(this.path);
		this.parent = parent;
		this.vault = null;
	}
}

export class TFile extends TAbstractFile {
	stat: HeadlessFileStats;
	basename: string;
	extension: string;

	constructor(path: string, stat: HeadlessFileStats, parent: TFolder | null = null) {
		super(path, parent);
		this.stat = stat;
		const ext = extname(this.name);
		this.extension = ext.startsWith(".") ? ext.slice(1) : ext;
		this.basename = ext ? this.name.slice(0, -ext.length) : this.name;
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];

	isRoot(): boolean {
		return this.path === "/";
	}
}

export function normalizePath(path: string): string {
	const normalized = path
		.replace(/\\/g, "/")
		.split("/")
		.filter((part) => part.length > 0 && part !== ".")
		.join("/");
	return normalized;
}

export function parentFolderForPath(path: string): TFolder | null {
	const normalized = normalizePath(path);
	const parent = dirname(normalized);
	if (!parent || parent === ".") return null;
	return new TFolder(parent);
}

