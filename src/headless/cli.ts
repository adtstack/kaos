#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import * as Y from "yjs";
import { parseExcludePatterns } from "../sync/exclude";
import { DEFAULT_SETTINGS } from "../settings/settingsStore";
import { HEADLESS_CLIENT_KIND, HeadlessVaultDoc } from "./doc";
import { NodeVaultFilesystem } from "./fsAdapter";
import { HeadlessReconciler, type HeadlessLogEvent } from "./reconciler";
import { JsonHeadlessStateStore, type HeadlessState } from "./stateStore";
import { HeadlessSyncClient, type HeadlessProviderLogEvent } from "./provider";

interface CliOptions {
	vaultRoot: string;
	host: string;
	token: string;
	vaultId: string;
	deviceName: string;
	stateDir: string;
	configDir: string;
	excludePatterns: string[];
	maxFileSizeBytes: number;
	intervalMs: number;
	once: boolean;
	syncTimeoutMs: number;
	settleMs: number;
}

export async function runHeadlessCli(argv: string[] = process.argv.slice(2)): Promise<void> {
	const options = await parseArgs(argv);
	await mkdir(options.stateDir, { recursive: true });

	const ydoc = new Y.Doc();
	const vaultDoc = new HeadlessVaultDoc(ydoc);
	const fs = new NodeVaultFilesystem(options.vaultRoot, {
		excludePatterns: options.excludePatterns,
		configDir: options.configDir,
		maxFileSizeBytes: options.maxFileSizeBytes,
		trashDir: join(options.stateDir, "trash"),
	});
	const store = new JsonHeadlessStateStore(
		join(options.stateDir, "state.json"),
		options.deviceName,
		options.vaultId,
	);
	const reconciler = new HeadlessReconciler({
		fs,
		doc: vaultDoc,
		deviceName: options.deviceName,
		log: (event) => logReconcileEvent(event),
	});
	const client = new HeadlessSyncClient(ydoc, {
		host: options.host,
		token: options.token,
		vaultId: options.vaultId,
		deviceName: options.deviceName,
		connectTimeoutMs: options.syncTimeoutMs,
		log: (event) => logProviderEvent(event),
	});

	let state: HeadlessState = await store.load();
	let running = false;
	let stopped = false;
	let interval: ReturnType<typeof setInterval> | null = null;

	const shutdown = async (signal: string) => {
		if (stopped) return;
		stopped = true;
		if (interval) clearInterval(interval);
		client.destroy();
		ydoc.destroy();
		log("shutdown", { signal });
	};

	process.once("SIGINT", () => {
		void shutdown("SIGINT").finally(() => process.exit(0));
	});
	process.once("SIGTERM", () => {
		void shutdown("SIGTERM").finally(() => process.exit(0));
	});

	try {
		log("starting", {
			vaultRoot: options.vaultRoot,
			stateDir: options.stateDir,
			vaultId: redactVaultId(options.vaultId),
			deviceName: options.deviceName,
			once: options.once,
			intervalMs: options.intervalMs,
		});
		await client.connect();
		await client.waitForSync(options.syncTimeoutMs);
		vaultDoc.markSchemaCurrent(options.deviceName);
		await reconcile("startup");

		if (options.once) {
			if (options.settleMs > 0) await sleep(options.settleMs);
			return;
		}

		interval = setInterval(() => {
			void reconcile("interval").catch((err) => {
				log("reconcile-failed", {
					reason: "interval",
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, options.intervalMs);
		await new Promise<void>(() => {
			// Keep the process alive until a signal arrives.
		});
	} finally {
		await shutdown("finally");
	}

	async function reconcile(reason: string): Promise<void> {
		if (running) {
			log("reconcile-skipped", { reason, cause: "previous-cycle-running" });
			return;
		}
		running = true;
		try {
			const result = await reconciler.reconcileOnce(state);
			state = result.state;
			await store.save(state);
			log("reconciled", { reason, stats: result.stats });
		} finally {
			running = false;
		}
	}
}

async function parseArgs(argv: string[]): Promise<CliOptions> {
	const raw = parseKeyValueArgs(argv);
	if (raw.help === "true") {
		printUsage();
		process.exit(0);
	}

	const vaultRoot = resolve(required(raw, "vault", process.env.KAOS_VAULT_PATH));
	const host = required(raw, "host", process.env.KAOS_HOST).replace(/\/$/, "");
	const vaultId = required(raw, "vault-id", process.env.KAOS_VAULT_ID);
	const token = await readToken(raw);
	const stateDir = resolve(raw["state-dir"] ?? join(vaultRoot, ".kaos-headless"));
	const configDir = raw["config-dir"] ?? ".obsidian";
	const deviceName = raw["device-name"] ?? process.env.KAOS_DEVICE_NAME ?? `${HEADLESS_CLIENT_KIND}-${hostname()}`;
	const maxFileSizeKB = parsePositiveInt(raw["max-file-size-kb"], DEFAULT_SETTINGS.maxFileSizeKB, "max-file-size-kb");
	const intervalMs = parsePositiveInt(raw["interval-ms"], 5_000, "interval-ms");
	const syncTimeoutMs = parsePositiveInt(raw["sync-timeout-ms"], 30_000, "sync-timeout-ms");
	const settleMs = parseNonNegativeInt(raw["settle-ms"], 1_000, "settle-ms");
	const excludes = raw.exclude ?? process.env.KAOS_EXCLUDE_PATTERNS ?? DEFAULT_SETTINGS.excludePatterns;

	return {
		vaultRoot,
		host,
		token,
		vaultId,
		deviceName,
		stateDir,
		configDir,
		excludePatterns: parseExcludePatterns(excludes),
		maxFileSizeBytes: maxFileSizeKB * 1024,
	intervalMs,
		once: raw.once === "true",
		syncTimeoutMs,
		settleMs,
	};
}

function parseKeyValueArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			out.help = "true";
			continue;
		}
		if (arg === "--once") {
			out.once = "true";
			continue;
		}
		if (!arg.startsWith("--")) {
			throw new Error(`unexpected positional argument: ${arg}`);
		}
		const withoutPrefix = arg.slice(2);
		const eq = withoutPrefix.indexOf("=");
		if (eq >= 0) {
			out[withoutPrefix.slice(0, eq)] = withoutPrefix.slice(eq + 1);
			continue;
		}
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			throw new Error(`missing value for --${withoutPrefix}`);
		}
		out[withoutPrefix] = next;
		i += 1;
	}
	return out;
}

async function readToken(raw: Record<string, string>): Promise<string> {
	if (raw.token) return raw.token.trim();
	if (raw["token-file"]) {
		return (await readFile(resolve(raw["token-file"]), "utf8")).trim();
	}
	const envToken = process.env.KAOS_SYNC_TOKEN ?? process.env.SYNC_TOKEN;
	if (envToken?.trim()) return envToken.trim();
	throw new Error("missing --token, --token-file, KAOS_SYNC_TOKEN, or SYNC_TOKEN");
}

function required(raw: Record<string, string>, key: string, fallback?: string): string {
	const value = raw[key] ?? fallback;
	if (!value?.trim()) throw new Error(`missing --${key}`);
	return value.trim();
}

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`--${label} must be a positive integer`);
	}
	return parsed;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, label: string): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`--${label} must be a non-negative integer`);
	}
	return parsed;
}

function logReconcileEvent(event: HeadlessLogEvent): void {
	log(event.kind, event);
}

function logProviderEvent(event: HeadlessProviderLogEvent): void {
	log(event.kind, event);
}

function log(kind: string, data: Record<string, unknown>): void {
	console.log(JSON.stringify({
		ts: new Date().toISOString(),
		runtime: HEADLESS_CLIENT_KIND,
		kind,
		...data,
	}));
}

function redactVaultId(vaultId: string): string {
	return `${vaultId.slice(0, 8)}...`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printUsage(): void {
	console.log(`Usage: npm run headless -- --vault <path> --host <url> --vault-id <id> [--token <secret>|--token-file <path>]

Options:
  --once                    Run one reconciliation cycle, then exit.
  --interval-ms <ms>        Background reconcile interval. Default: 5000.
  --state-dir <path>        State/trash directory. Default: <vault>/.kaos-headless.
  --device-name <name>      Device name. Default: kaos-headless-<hostname>.
  --exclude <csv>           Comma-separated vault-relative path prefixes.
  --max-file-size-kb <kb>   Markdown CRDT size limit. Default: ${DEFAULT_SETTINGS.maxFileSizeKB}.
  --config-dir <path>       Obsidian config directory to exclude. Default: .obsidian.
  --sync-timeout-ms <ms>    Initial Yjs sync timeout. Default: 30000.
  --settle-ms <ms>          Extra wait after --once reconcile. Default: 1000.
`);
}

function isMainModule(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	return pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
	runHeadlessCli().catch((err) => {
		console.error(JSON.stringify({
			ts: new Date().toISOString(),
			runtime: HEADLESS_CLIENT_KIND,
			kind: "fatal",
			error: err instanceof Error ? err.message : String(err),
		}));
		process.exitCode = 1;
	});
}
