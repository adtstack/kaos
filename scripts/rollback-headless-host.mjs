#!/usr/bin/env node
import { access, chmod, copyFile, mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

const DEFAULT_BINARY_NAME = "kaos-headless-host.mjs";
const HELPERS = [
	"install-headless-host.mjs",
	"bootstrap-headless-host-oracle.mjs",
	"uninstall-headless-host.mjs",
	"update-headless-host-from-release.mjs",
	"verify-headless-host-bundle.mjs",
	"validate-headless-host-release-assets.mjs",
	"run-headless-host-oracle-rehearsal.mjs",
	"run-headless-host-oracle-remote-rehearsal.mjs",
	"run-headless-host-oracle-acceptance.mjs",
	"verify-headless-host-oracle-acceptance.mjs",
	"verify-headless-host-oracle-rehearsal.mjs",
	"smoke-headless-host-sync.mjs",
	"postflight-headless-host.mjs",
	"rollback-headless-host.mjs",
];

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}

	const installDir = resolve(raw["install-dir"] ?? "/opt/kaos");
	const binaryName = raw["binary-name"] ?? DEFAULT_BINARY_NAME;
	const dryRun = raw["dry-run"] === "true";
	const rollbackStamp = raw["rollback-stamp"] ?? new Date().toISOString().replace(/[:.]/g, "-");
	const serviceEnabled = raw["no-service"] !== "true";
	const helpersEnabled = raw["no-helper-scripts"] !== "true";
	const metadataEnabled = raw["no-metadata"] !== "true";
	const metadataPath = metadataEnabled
		? resolve(raw["metadata-path"] ?? join(installDir, ".kaos-headless-install.json"))
		: undefined;
	const servicePath = serviceEnabled
		? resolve(raw["service-path"] ?? "/etc/systemd/system/kaos-headless-host.service")
		: undefined;

	const targets = [
		{ kind: "binary", path: resolve(installDir, binaryName), mode: 0o755 },
		...(servicePath ? [{ kind: "service", path: servicePath, mode: 0o644 }] : []),
		...(helpersEnabled ? HELPERS.map((helper) => ({ kind: "helper", path: resolve(installDir, helper), mode: 0o755 })) : []),
		...(metadataPath ? [{ kind: "metadata", path: metadataPath, mode: 0o644, optional: true }] : []),
	];

	const restored = [];
	for (const target of targets) {
		restored.push(await restorePrevious(target, rollbackStamp, dryRun));
	}

	console.log(JSON.stringify({
		kind: "headless-host-rollback",
		ok: true,
		dryRun,
		installDir,
		servicePath: servicePath ?? null,
		metadataPath: metadataPath ?? null,
		rollbackStamp,
		restored,
	}, null, 2));
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = "true";
			continue;
		}
		if (arg === "--dry-run") {
			out["dry-run"] = "true";
			continue;
		}
		if (arg === "--no-service") {
			out["no-service"] = "true";
			continue;
		}
		if (arg === "--no-helper-scripts") {
			out["no-helper-scripts"] = "true";
			continue;
		}
		if (arg === "--no-metadata") {
			out["no-metadata"] = "true";
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
		if (!next || next.startsWith("--")) {
			throw new Error(`missing value for --${withoutPrefix}`);
		}
		out[withoutPrefix] = next;
		i++;
	}
	return out;
}

async function restorePrevious(target, rollbackStamp, dryRun) {
	const previousPath = `${target.path}.previous`;
	const failedPath = `${target.path}.failed-${rollbackStamp}`;
	if (target.optional && !(await pathExists(previousPath))) {
		return {
			kind: target.kind,
			target: target.path,
			previousPath,
			failedPath: null,
			restored: false,
			skipped: true,
			reason: "previous file is not present",
		};
	}
	await assertReadable(previousPath, `${target.kind} rollback source`);
	const activeExists = await pathExists(target.path);
	if (dryRun) {
		return {
			kind: target.kind,
			target: target.path,
			previousPath,
			failedPath: activeExists ? failedPath : null,
			restored: false,
		};
	}

	await mkdir(dirname(target.path), { recursive: true });
	const tempPath = `${target.path}.rollback-${process.pid}-${Date.now()}-${basename(target.path)}`;
	try {
		await copyFile(previousPath, tempPath);
		await chmod(tempPath, target.mode);
		if (activeExists) {
			await rename(target.path, failedPath);
		}
		await rename(tempPath, target.path);
		const installedMode = (await stat(target.path)).mode & 0o777;
		return {
			kind: target.kind,
			target: target.path,
			previousPath,
			failedPath: activeExists ? failedPath : null,
			restored: true,
			mode: `0${installedMode.toString(8)}`,
		};
	} catch (err) {
		if (!(await pathExists(target.path)) && await pathExists(failedPath)) {
			await rename(failedPath, target.path).catch(() => undefined);
		}
		throw err;
	}
}

async function assertReadable(path, label) {
	try {
		await access(path);
	} catch (err) {
		throw new Error(`${label} is not readable at ${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function printUsage() {
	console.log(`Usage: node scripts/rollback-headless-host.mjs [options]

Options:
  --install-dir <path>       Directory for kaos-headless-host.mjs and helper scripts.
                             Defaults to /opt/kaos.
  --binary-name <name>       Installed binary name. Defaults to kaos-headless-host.mjs.
  --service-path <path>      systemd service destination. Defaults to
                             /etc/systemd/system/kaos-headless-host.service.
  --no-service               Do not restore the systemd service file.
  --no-helper-scripts        Do not restore install/update/verify/rehearsal/smoke/postflight/rollback helper scripts.
  --metadata-path <path>     Install metadata JSON. Defaults below --install-dir.
  --no-metadata              Do not restore install metadata.
  --rollback-stamp <stamp>   Suffix used for .failed-<stamp> backups.
  --dry-run                  Check rollback sources and print planned actions without writing.
  --help, -h                 Print this help.
`);
}

main().catch((err) => {
	console.error(JSON.stringify({
		kind: "headless-host-rollback",
		ok: false,
		error: err instanceof Error ? err.message : String(err),
	}));
	process.exitCode = 1;
});
