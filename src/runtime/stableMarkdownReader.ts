export interface StableMarkdownStat {
	mtime: number;
	size: number;
}

export type StableMarkdownSnapshot<TFile> =
	| { kind: "ready"; file: TFile; content: string; stat: StableMarkdownStat }
	| { kind: "missing" }
	| { kind: "unstable" };

interface StableMarkdownReaderDeps<TFile> {
	stat(path: string): Promise<StableMarkdownStat | null>;
	getFile(path: string): TFile | null;
	read(file: TFile): Promise<string>;
	trace(
		message: string,
		details: Record<string, unknown>,
	): void;
	sleep?(delayMs: number): Promise<void>;
}

type StatAttempt =
	| { kind: "ready"; stat: StableMarkdownStat }
	| { kind: "missing" }
	| { kind: "error"; error: unknown };

/**
 * Capture a stat/read/stat-stable Markdown snapshot.
 *
 * A null stat is an authoritative missing-path observation. A rejected stat is
 * deliberately different: adapters can transiently fail while mobile storage
 * is waking or a provider mount is reconnecting, so callers must retry it as an
 * unstable read instead of treating it as a deletion.
 */
export async function readStableMarkdownSnapshot<TFile>(
	deps: StableMarkdownReaderDeps<TFile>,
	path: string,
	reason: string,
): Promise<StableMarkdownSnapshot<TFile>> {
	const sleep = deps.sleep
		? (delayMs: number) => deps.sleep!(delayMs)
		: (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
	const statPath = async (): Promise<StatAttempt> => {
		try {
			const stat = await deps.stat(path);
			return stat
				? { kind: "ready", stat: { mtime: stat.mtime, size: stat.size } }
				: { kind: "missing" };
		} catch (error) {
			return { kind: "error", error };
		}
	};
	const traceStatError = (phase: string, error: unknown): void => {
		deps.trace("markdown-stable-read-stat-unavailable", {
			path,
			reason,
			phase,
			error: error instanceof Error ? error.message : String(error),
		});
	};
	const sameStat = (a: StableMarkdownStat | null, b: StableMarkdownStat): boolean =>
		!!a && a.mtime === b.mtime && a.size === b.size;

	let previous: StableMarkdownStat | null = null;
	let stable: StableMarkdownStat | null = null;
	for (let i = 0; i < 3; i++) {
		const current = await statPath();
		if (current.kind === "error") {
			traceStatError("pre-read", current.error);
			return { kind: "unstable" };
		}
		if (current.kind === "missing") return { kind: "missing" };
		if (sameStat(previous, current.stat)) {
			stable = current.stat;
			break;
		}
		previous = current.stat;
		if (i < 2) await sleep(400);
	}

	if (!stable) {
		deps.trace("markdown-stable-read-unstable", {
			path,
			reason,
			phase: "pre-read",
		});
		return { kind: "unstable" };
	}

	const file = deps.getFile(path);
	if (!file) {
		deps.trace("markdown-stable-read-file-unavailable", {
			path,
			reason,
			phase: "get-file",
		});
		return { kind: "unstable" };
	}

	const beforeRead = await statPath();
	if (beforeRead.kind === "error") {
		traceStatError("before-read", beforeRead.error);
		return { kind: "unstable" };
	}
	if (beforeRead.kind === "missing") return { kind: "missing" };
	if (!sameStat(stable, beforeRead.stat)) {
		deps.trace("markdown-stable-read-unstable", {
			path,
			reason,
			phase: "before-read",
		});
		return { kind: "unstable" };
	}

	let content: string;
	try {
		content = await deps.read(file);
	} catch (error) {
		deps.trace("markdown-stable-read-file-unavailable", {
			path,
			reason,
			phase: "read",
			error: error instanceof Error ? error.message : String(error),
		});
		return { kind: "unstable" };
	}
	const afterRead = await statPath();
	if (afterRead.kind === "error") {
		traceStatError("after-read", afterRead.error);
		return { kind: "unstable" };
	}
	if (afterRead.kind === "missing") return { kind: "missing" };
	if (!sameStat(beforeRead.stat, afterRead.stat)) {
		deps.trace("markdown-stable-read-unstable", {
			path,
			reason,
			phase: "after-read",
		});
		return { kind: "unstable" };
	}

	return { kind: "ready", file, content, stat: afterRead.stat };
}
