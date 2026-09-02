import { access, mkdtemp, readFile } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import { HeadlessVaultPoller, type HeadlessVaultPollerOptions } from "./core/vaultPoller";
import { bootKaosHeadlessPlugin } from "./kaos/bootKaosPlugin";
import { mergeConfigPatch, mergeKaosHeadlessConfig, readKaosHeadlessData, type KaosHeadlessConfigPatch } from "./kaos/config";
import { HeadlessHostLockfile } from "./kaos/lockfile";
import {
	formatHeadlessDoctor,
	formatHeadlessStatus,
	shouldUseHumanOutput,
} from "./humanOutput";
import {
	assertSecurePrivateFile,
	createHeadlessDeviceIdentity,
	HeadlessDeviceAuthClient,
	readHeadlessDeviceIdentity,
	readProtectedTextFile,
	requestHeadlessEnrollment,
	requestHeadlessRecovery,
	writeNewRecoverySecret,
} from "./kaos/deviceIdentity";

type CliMode = "run" | "status" | "dump-config" | "doctor";

interface CliOptions {
	mode: CliMode;
	vaultRoot: string;
	dataFile: string;
	lockFile: string;
	pluginId: string;
	pluginDir: string;
	bootOnly: boolean;
	pollIntervalMs: number;
	pollQuietMs: number;
	requireSyncConfig: boolean;
	skipWorkerCapabilities: boolean;
	forceJson: boolean;
	configPatch: KaosHeadlessConfigPatch;
}

export interface HeadlessHostRuntimeDeps {
	bootPlugin?: typeof bootKaosHeadlessPlugin;
	createPoller?: (
		vault: Awaited<ReturnType<typeof bootKaosHeadlessPlugin>>["app"]["vault"],
		options: HeadlessVaultPollerOptions,
	) => Pick<HeadlessVaultPoller, "start" | "stop">;
	waitForever?: () => Promise<void>;
}

export async function runHeadlessHostCli(
	argv: string[] = process.argv.slice(2),
	deps: HeadlessHostRuntimeDeps = {},
): Promise<void> {
	assertNoLegacyTokenEnvironment();
	if (argv[0] === "device") {
		await runDeviceCommand(argv.slice(1));
		return;
	}
	const options = await parseArgs(argv);
	if (options.mode === "status") {
		await printStatus(options);
		return;
	}
	if (options.mode === "dump-config") {
		await printDumpConfig(options);
		return;
	}
	if (options.mode === "doctor") {
		const ok = await printDoctor(options);
		if (!ok) process.exitCode = 1;
		return;
	}
	const bootPlugin = deps.bootPlugin ?? bootKaosHeadlessPlugin;
	const createPoller = deps.createPoller ?? ((vault, pollerOptions) => new HeadlessVaultPoller(vault, pollerOptions));
	const waitForever = deps.waitForever ?? (() => new Promise<void>(() => {}));
	const lockfile = new HeadlessHostLockfile(options.lockFile, {
		vaultRoot: options.vaultRoot,
		dataFile: options.dataFile,
	});
	await lockfile.acquire();
	let lockReleased = false;
	const releaseLock = async (): Promise<void> => {
		if (lockReleased) return;
		lockReleased = true;
		await lockfile.release();
	};
	let shutdown: ((reason: string) => Promise<void>) | null = null;
	let exitPending = false;
	const exitAfterShutdown = (reason: string, exitCode: number, err?: unknown): void => {
		if (exitPending) return;
		exitPending = true;
		if (err !== undefined) {
			log("fatal", { reason, error: errorMessage(err) });
		}
		const timer = setTimeout(() => process.exit(exitCode), 5000);
		timer.unref?.();
		void (shutdown ? shutdown(reason) : releaseLock())
			.catch((shutdownErr) => {
				log("fatal-cleanup-failed", { reason, error: errorMessage(shutdownErr) });
			})
			.finally(() => {
				clearTimeout(timer);
				process.exit(exitCode);
			});
	};
	const onSigint = (): void => exitAfterShutdown("SIGINT", 0);
	const onSigterm = (): void => exitAfterShutdown("SIGTERM", 0);
	const onUncaughtException = (err: unknown): void => exitAfterShutdown("uncaughtException", 1, err);
	const onUnhandledRejection = (reason: unknown): void => exitAfterShutdown("unhandledRejection", 1, reason);
	const removeProcessHandlers = (): void => {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		process.off("uncaughtException", onUncaughtException);
		process.off("unhandledRejection", onUnhandledRejection);
	};
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	process.once("uncaughtException", onUncaughtException);
	process.once("unhandledRejection", onUnhandledRejection);
	try {
		assertNoLegacyTokenConfiguration(await readKaosHeadlessData(options.dataFile));
		await mergeKaosHeadlessConfig(options.dataFile, options.configPatch);
		const { app, plugin } = await bootPlugin({
			vaultRoot: options.vaultRoot,
			dataFile: options.dataFile,
			pluginId: options.pluginId,
			pluginDir: options.pluginDir,
		});
		const poller = createPoller(app.vault, {
			intervalMs: options.pollIntervalMs,
			quietMs: options.pollQuietMs,
		});
		let stopped = false;
		shutdown = async (reason: string): Promise<void> => {
			if (stopped) return;
			stopped = true;
			poller.stop();
			let unloadError: unknown;
			try {
				await Promise.resolve(plugin.onunload());
			} catch (err) {
				unloadError = err;
				log("plugin-unload-failed", { reason, error: errorMessage(err) });
			} finally {
				await releaseLock();
				removeProcessHandlers();
			}
			log("shutdown", { reason });
			await sleep(750);
			if (reason === "boot-only" && unloadError !== undefined) {
				throw unloadError instanceof Error
					? unloadError
					: new Error(errorMessage(unloadError));
			}
		};
		log("booted", {
			vaultRoot: options.vaultRoot,
			dataFile: options.dataFile,
			lockFile: options.lockFile,
			pluginId: options.pluginId,
			pluginDir: options.pluginDir,
		});
		if (options.bootOnly) {
			await shutdown("boot-only");
			return;
		}
		await poller.start();
		log("poller-started", { intervalMs: options.pollIntervalMs, quietMs: options.pollQuietMs });
		await waitForever();
	} catch (err) {
		removeProcessHandlers();
		await releaseLock().catch(() => undefined);
		throw err;
	}
}

async function parseArgs(argv: string[]): Promise<CliOptions> {
	const raw = parseKeyValueArgs(argv);
	for (const forbidden of ["token", "token-file", "token-stdin"]) {
		if (raw[forbidden] !== undefined) throw new Error(`--${forbidden} is no longer supported; enroll a device key instead.`);
	}
	if (raw.help === "true") {
		printUsage();
		process.exit(0);
	}
	const defaultRoot = await mkdtemp(join(tmpdir(), "kaos-headless-host-"));
	const vaultRoot = resolve(raw.vault ?? defaultRoot);
	const dataFile = resolve(raw["data-file"] ?? join(vaultRoot, ".kaos-headless-host", "data.json"));
	const pluginId = readStringOption(raw["plugin-id"], process.env.KAOS_PLUGIN_ID) ?? "kaos";
	const pluginDir = resolve(raw["plugin-dir"] ?? process.env.KAOS_PLUGIN_DIR ?? join(vaultRoot, ".obsidian", "plugins", pluginId));
	return {
		mode: readMode(raw),
		vaultRoot,
		dataFile,
		lockFile: resolve(raw["lock-file"] ?? `${dataFile}.lock`),
		pluginId,
		pluginDir,
		bootOnly: raw["boot-only"] === "true",
		pollIntervalMs: parsePositiveInt(raw["poll-interval-ms"], 1000, "poll-interval-ms"),
		pollQuietMs: parseNonNegativeInt(raw["poll-quiet-ms"], 1100, "poll-quiet-ms"),
		requireSyncConfig: raw["require-sync-config"] === "true",
		skipWorkerCapabilities: raw["skip-worker-capabilities"] === "true",
		forceJson: raw.json === "true",
		configPatch: {
			host: readStringOption(raw.host, process.env.KAOS_HOST),
			vaultId: readStringOption(raw["vault-id"], process.env.KAOS_VAULT_ID),
			deviceName: readStringOption(raw["device-name"], process.env.KAOS_DEVICE_NAME),
			deviceId: readStringOption(raw["device-id"]),
			identityFile: readStringOption(raw["identity-file"]),
			enableAttachmentSync: readAttachmentFlag(raw),
		},
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
		if (arg === "--boot-only") {
			out["boot-only"] = "true";
			continue;
		}
		if (arg === "--status" || arg === "--dump-config" || arg === "--doctor" || arg === "--json") {
			out[arg.slice(2)] = "true";
			continue;
		}
		if (arg === "--enable-attachments") {
			out["enable-attachments"] = "true";
			continue;
		}
		if (arg === "--disable-attachments") {
			out["disable-attachments"] = "true";
			continue;
		}
		if (arg === "--require-sync-config") {
			out["require-sync-config"] = "true";
			continue;
		}
		if (arg === "--skip-worker-capabilities") {
			out["skip-worker-capabilities"] = "true";
			continue;
		}
		if (arg === "--confirm-revoke-all") {
			out["confirm-revoke-all"] = "true";
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
		const key = withoutPrefix;
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) throw new Error(`missing value for --${key}`);
		out[key] = next;
		i++;
	}
	return out;
}

async function runDeviceCommand(argv: string[]): Promise<void> {
	const action = argv[0];
	if (action !== "enroll" && action !== "pair" && action !== "recover" && action !== "verify") {
		throw new Error("Usage: device pair …, device enroll …, device recover …, or device verify …");
	}
	const options = await parseArgs(argv.slice(1));
	const raw = parseKeyValueArgs(argv.slice(1));
	const existing = await readKaosHeadlessData(options.dataFile);
	assertNoLegacyTokenConfiguration(existing);
	const config = mergeConfigPatch(existing, options.configPatch);
	const identityFile = readStringOption(raw["identity-file"], typeof config.identityFile === "string" ? config.identityFile : undefined);
	const host = readStringOption(raw.host, typeof config.host === "string" ? config.host : undefined);
	const vaultId = readStringOption(raw["vault-id"], typeof config.vaultId === "string" ? config.vaultId : undefined);
	const deviceName = readStringOption(raw["device-name"], typeof config.deviceName === "string" ? config.deviceName : undefined);
	if (!identityFile || !host || !vaultId || !deviceName) {
		throw new Error("--identity-file, --host, --vault-id, and --device-name are required (or must already exist in data.json).");
	}
	if (action === "verify") {
		const identity = await readHeadlessDeviceIdentity(identityFile);
		if (identity.host !== host.trim().replace(/\/$/, "") || identity.vaultId !== vaultId.trim()) {
			throw new Error("Identity file belongs to a different --host or --vault-id.");
		}
		if (typeof config.deviceId === "string" && config.deviceId && config.deviceId !== identity.deviceId) {
			throw new Error("Configured device ID does not match the protected identity file.");
		}
		const client = new HeadlessDeviceAuthClient({
			host,
			vaultId,
			deviceName,
			deviceId: identity.deviceId,
			identityFile,
			persistDeviceId: async () => undefined,
		});
		const session = await client.getSession();
		log("device-verified", { deviceId: session.deviceId, role: session.role, expiresAt: session.expiresAt });
		return;
	}
	if (action === "enroll" || action === "pair") {
		const code = raw["code"];
		const secret = raw["secret"];
		const inviteFile = raw["invite-file"];
		const invite = inviteFile ? await readProtectedTextFile(inviteFile) : undefined;
		if (!code && !secret && !invite) {
			throw new Error("device pair/enroll requires --code <CODE>, --secret <SECRET>, or --invite-file.");
		}
		const identity = await loadOrCreateIdentity(identityFile, host, vaultId);
		const enrollment = await requestHeadlessEnrollment({ identity, deviceName, code, qrSecret: secret, invite });
		await mergeKaosHeadlessConfig(options.dataFile, {
			host: identity.host,
			vaultId: identity.vaultId,
			deviceName,
			deviceId: identity.deviceId,
			identityFile: resolve(identityFile),
		});
		log("device-enrollment", {
			status: enrollment.status,
			deviceId: identity.deviceId,
			fingerprint: enrollment.fingerprint,
			identityFile: resolve(identityFile),
		});
		return;
	}

	if (raw["confirm-revoke-all"] !== "true") {
		throw new Error("device recover requires --confirm-revoke-all because it revokes every existing device, session, and invitation.");
	}
	const recoveryFile = raw["recovery-file"];
	const nextRecoveryFile = raw["next-recovery-file"];
	if (!recoveryFile || !nextRecoveryFile) {
		throw new Error("device recover requires --recovery-file and a new --next-recovery-file, both protected regular files.");
	}
	const recoverySecret = await readProtectedTextFile(recoveryFile);
	const nextRecoverySecret = await writeNewRecoverySecret(nextRecoveryFile);
	const identity = await loadOrCreateIdentity(identityFile, host, vaultId);
	try {
		await requestHeadlessRecovery({ identity, deviceName, recoverySecret, nextRecoverySecret });
	} catch (error) {
		throw new Error(`Recovery did not complete; the new recovery file was created but is not active. ${errorMessage(error)}`);
	}
	await mergeKaosHeadlessConfig(options.dataFile, {
		host: identity.host,
		vaultId: identity.vaultId,
		deviceName,
		deviceId: identity.deviceId,
		identityFile: resolve(identityFile),
	});
	log("device-recovery", { status: "completed", deviceId: identity.deviceId, identityFile: resolve(identityFile) });
}

async function loadOrCreateIdentity(identityFile: string, host: string, vaultId: string) {
	if (await pathExists(identityFile)) {
		const identity = await readHeadlessDeviceIdentity(identityFile);
		if (identity.host !== host.trim().replace(/\/$/, "") || identity.vaultId !== vaultId.trim()) {
			throw new Error("Identity file belongs to a different --host or --vault-id.");
		}
		return identity;
	}
	return await createHeadlessDeviceIdentity({ identityFile, host, vaultId });
}

function readStringOption(...values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		if (value?.trim()) return value.trim();
	}
	return undefined;
}

function assertNoLegacyTokenEnvironment(): void {
	if (readStringOption(process.env.KAOS_SYNC_TOKEN, process.env.SYNC_TOKEN)) {
		throw new Error("KAOS_SYNC_TOKEN and SYNC_TOKEN are no longer supported; remove them and use a protected device identity file.");
	}
}

function assertNoLegacyTokenConfiguration(config: Record<string, unknown>): void {
	if (typeof config.token === "string" && config.token.trim()) {
		throw new Error("Legacy token material is present in data.json. Remove it before using device-key authentication.");
	}
}

function readAttachmentFlag(raw: Record<string, string>): boolean | undefined {
	if (raw["enable-attachments"] === "true" && raw["disable-attachments"] === "true") {
		throw new Error("--enable-attachments and --disable-attachments cannot be used together");
	}
	if (raw["enable-attachments"] === "true") return true;
	if (raw["disable-attachments"] === "true") return false;
	const env = readStringOption(process.env.KAOS_ENABLE_ATTACHMENT_SYNC);
	if (env === undefined) return undefined;
	return env === "1" || env.toLowerCase() === "true";
}

function readMode(raw: Record<string, string>): CliMode {
	const modes: CliMode[] = [];
	if (raw.status === "true") modes.push("status");
	if (raw["dump-config"] === "true") modes.push("dump-config");
	if (raw.doctor === "true") modes.push("doctor");
	if (modes.length > 1) throw new Error("--status, --dump-config, and --doctor are mutually exclusive");
	return modes[0] ?? "run";
}

function printUsage(): void {
	console.log(`Usage: npm run headless:host -- [--vault <path>] [--data-file <path>] [--boot-only] [--poll-interval-ms <ms>]

Options:
  --status                    Print current headless host status and exit.
  --dump-config               Print resolved config JSON with secrets redacted and exit.
  --doctor                    Check local paths and optional Worker capabilities, then exit.
  --json                      Force JSON output with --status or --doctor.
  --require-sync-config       With --doctor, fail unless host/vaultId/deviceName/device identity are configured.
  --skip-worker-capabilities  With --doctor, skip the Worker /api/capabilities network probe.
  --vault <path>              Vault root. Defaults to a temporary directory.
  --data-file <path>          Plugin data.json path. Defaults below the vault root.
  --lock-file <path>          Lock file path. Defaults to <data-file>.lock.
  --plugin-id <id>            Vault plugin id/directory name. Defaults to kaos.
  --plugin-dir <path>         Exact vault plugin directory. Defaults to <vault>/.obsidian/plugins/<plugin-id>.
  --host <url>                KAOS Worker host. Can also use KAOS_HOST.
	--vault-id <id>             KAOS vault id. Can also use KAOS_VAULT_ID.
	--device-name <name>        KAOS device name. Can also use KAOS_DEVICE_NAME.
	--identity-file <path>      Protected 0600 headless device identity file.
  --enable-attachments        Persist enableAttachmentSync=true before boot.
  --disable-attachments       Persist enableAttachmentSync=false before boot.
  --boot-only                 Boot the real KAOS plugin, then unload and exit.
  --poll-interval-ms <ms>     External file scan interval. Defaults to 1000.
	--poll-quiet-ms <ms>        File quiet window before emitting events. Defaults to 1100.

Device enrollment:
  device enroll --host <url> --vault-id <id> --device-name <name> --identity-file <0600-file> --invite-file <0600-file>
  device verify --host <url> --vault-id <id> --device-name <name> --identity-file <0600-file>
  device recover --host <url> --vault-id <id> --device-name <name> --identity-file <0600-file> --recovery-file <0600-file> --next-recovery-file <new-0600-file> --confirm-revoke-all
`);
}

async function printStatus(options: CliOptions): Promise<void> {
	const data = mergeConfigPatch(await readKaosHeadlessData(options.dataFile), options.configPatch);
	const lock = await readLockStatus(options.lockFile);
	const status = {
		vaultRoot: options.vaultRoot,
		dataFile: options.dataFile,
		lockFile: options.lockFile,
		pluginId: options.pluginId,
		pluginDir: options.pluginDir,
		lockHeld: lock.held,
		lock,
		configured: summarizeConfig(data),
	};
	if (useHumanOutput(options)) {
		console.log(formatHeadlessStatus(status));
	} else {
		log("status", status);
	}
}

async function printDumpConfig(options: CliOptions): Promise<void> {
	const data = mergeConfigPatch(await readKaosHeadlessData(options.dataFile), options.configPatch);
	log("config", {
		vaultRoot: options.vaultRoot,
		dataFile: options.dataFile,
		lockFile: options.lockFile,
		pluginId: options.pluginId,
		pluginDir: options.pluginDir,
		configured: summarizeConfig(data),
	});
}

async function printDoctor(options: CliOptions): Promise<boolean> {
	const data = mergeConfigPatch(await readKaosHeadlessData(options.dataFile), options.configPatch);
	const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
	checks.push(await checkPath("vault-root-readable", options.vaultRoot, constants.R_OK | constants.X_OK));
	checks.push(await checkPath("data-dir-readable", dirname(options.dataFile), constants.R_OK | constants.X_OK));
	checks.push(await checkPath("lock-dir-readable", dirname(options.lockFile), constants.R_OK | constants.X_OK));
	checks.push(await checkPath("plugin-dir-readable", options.pluginDir, constants.R_OK | constants.X_OK));
	checks.push(await checkPath("plugin-manifest-readable", join(options.pluginDir, "manifest.json"), constants.R_OK));
	checks.push(await checkPath("plugin-main-readable", join(options.pluginDir, "main.js"), constants.R_OK));
	if (options.requireSyncConfig) {
		checks.push(await checkPath("vault-root-writable", options.vaultRoot, constants.W_OK | constants.X_OK));
		checks.push(await checkPath("data-dir-writable", dirname(options.dataFile), constants.W_OK | constants.X_OK));
		checks.push(await checkPath("lock-dir-writable", dirname(options.lockFile), constants.W_OK | constants.X_OK));
		checks.push(...checkSyncConfig(data));
		const identityFile = typeof data.identityFile === "string" ? data.identityFile.trim() : "";
		checks.push(await checkProtectedIdentity(identityFile));
	}
	const host = typeof data.host === "string" ? data.host : "";
	if (options.skipWorkerCapabilities) {
		checks.push({ name: "worker-capabilities", ok: true, detail: "skipped: --skip-worker-capabilities" });
	} else if (host) {
		checks.push(await checkCapabilities(host));
	} else {
		checks.push({ name: "worker-capabilities", ok: true, detail: "skipped: host not configured" });
	}
	const ok = checks.every((check) => check.ok);
	const lock = await readLockStatus(options.lockFile);
	const doctor = {
		ok,
		vaultRoot: options.vaultRoot,
		dataFile: options.dataFile,
		lockFile: options.lockFile,
		pluginId: options.pluginId,
		pluginDir: options.pluginDir,
		lockHeld: lock.held,
		lock,
		configured: summarizeConfig(data),
		checks,
	};
	if (useHumanOutput(options)) {
		console.log(formatHeadlessDoctor(doctor));
	} else {
		log("doctor", doctor);
	}
	return ok;
}

function useHumanOutput(options: CliOptions): boolean {
	return shouldUseHumanOutput(process.stdout.isTTY, options.forceJson);
}

async function readLockStatus(path: string): Promise<Record<string, unknown>> {
	if (!await pathExists(path)) {
		return { path, held: false };
	}
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return {
			path,
			held: true,
			readable: true,
			info: summarizeLockInfo(parsed),
		};
	} catch (err) {
		return {
			path,
			held: true,
			readable: false,
			error: errorMessage(err),
		};
	}
}

function summarizeLockInfo(data: Record<string, unknown>): Record<string, unknown> {
	const pid = readPositiveInteger(data.pid);
	return {
		runtime: readString(data.runtime),
		pid,
		hostname: readString(data.hostname),
		startedAt: readString(data.startedAt),
		vaultRoot: readString(data.vaultRoot),
		dataFile: readString(data.dataFile),
		processAlive: checkProcessAlive(pid),
	};
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
	return value;
}

function checkProcessAlive(pid: number | null): boolean | null {
	if (pid === null) return null;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return null;
	}
}

function summarizeConfig(data: Record<string, unknown>): Record<string, unknown> {
	return {
		host: typeof data.host === "string" ? data.host : "",
		vaultId: typeof data.vaultId === "string" ? data.vaultId : "",
		deviceName: typeof data.deviceName === "string" ? data.deviceName : "",
		deviceId: typeof data.deviceId === "string" ? data.deviceId : "",
		identityFileConfigured: typeof data.identityFile === "string" && data.identityFile.length > 0,
		enableAttachmentSync: typeof data.enableAttachmentSync === "boolean" ? data.enableAttachmentSync : null,
	};
}

function checkSyncConfig(data: Record<string, unknown>): Array<{ name: string; ok: boolean; detail?: string }> {
	return [
		checkStringConfig(data, "host"),
		checkStringConfig(data, "vaultId"),
		checkStringConfig(data, "deviceName"),
		checkStringConfig(data, "deviceId"),
		checkStringConfig(data, "identityFile"),
	].map((check) => ({
		name: `sync-config:${check.name}`,
		ok: check.ok,
		detail: check.ok ? "configured" : "missing",
	}));
}

function checkStringConfig(data: Record<string, unknown>, name: string): { name: string; ok: boolean } {
	const value = data[name];
	return { name, ok: typeof value === "string" && value.trim().length > 0 };
}

async function checkPath(name: string, path: string, mode = constants.F_OK): Promise<{ name: string; ok: boolean; detail?: string }> {
	try {
		await access(path, mode);
		return { name, ok: true, detail: path };
	} catch (err) {
		return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

async function checkProtectedIdentity(path: string): Promise<{ name: string; ok: boolean; detail?: string }> {
	if (!path) return { name: "device-identity-protected", ok: false, detail: "identityFile is missing" };
	try {
		await assertSecurePrivateFile(path);
		return { name: "device-identity-protected", ok: true, detail: "regular file with protected permissions" };
	} catch (err) {
		return { name: "device-identity-protected", ok: false, detail: errorMessage(err) };
	}
}

async function checkCapabilities(host: string): Promise<{ name: string; ok: boolean; detail?: string }> {
	try {
		const res = await fetch(`${host.replace(/\/$/, "")}/api/capabilities`);
		return {
			name: "worker-capabilities",
			ok: res.ok,
			detail: `HTTP ${res.status}`,
		};
	} catch (err) {
		return { name: "worker-capabilities", ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`--${label} must be a positive integer`);
	}
	return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`--${label} must be a non-negative integer`);
	}
	return parsed;
}

function log(kind: string, data: Record<string, unknown>): void {
	console.log(JSON.stringify({
		ts: new Date().toISOString(),
		runtime: "kaos-headless-host",
		kind,
		...data,
	}));
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMainModule(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return pathToFileURL(resolve(entry)).href === import.meta.url;
	}
}

if (isMainModule()) {
	runHeadlessHostCli().catch((err) => {
		console.error(JSON.stringify({
			ts: new Date().toISOString(),
			runtime: "kaos-headless-host",
			kind: "fatal",
			error: err instanceof Error ? err.message : String(err),
		}));
		process.exitCode = 1;
	});
}
