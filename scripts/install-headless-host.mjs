#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

const DEFAULT_BINARY_NAME = "kaos-headless-host.mjs";

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}

	const source = resolve(raw.source ?? join("dist", DEFAULT_BINARY_NAME));
	const checksumPath = resolve(raw.checksum ?? `${source}.sha256`);
	const installDir = resolve(raw["install-dir"] ?? "/opt/kaos");
	const binaryName = raw["binary-name"] ?? DEFAULT_BINARY_NAME;
	const binaryPath = resolve(installDir, binaryName);
	const metadataPath = resolve(raw["metadata-path"] ?? join(installDir, ".kaos-headless-install.json"));
	const servicePath = raw["service-path"] ? resolve(raw["service-path"]) : undefined;
	const serviceSource = servicePath
		? resolve(raw["service-source"] ?? await findDefaultServiceSource(source))
		: undefined;
	const serviceNode = raw["service-node"] ? resolve(raw["service-node"]) : undefined;
	const dryRun = raw["dry-run"] === "true";

	const expectedSha256 = await readExpectedSha256(checksumPath);
	const actualSha256 = await sha256File(source);
	if (actualSha256 !== expectedSha256) {
		throw new Error(`checksum mismatch for ${source}: expected ${expectedSha256}, got ${actualSha256}`);
	}
	if (servicePath && serviceSource) {
		await assertReadable(serviceSource, "service source");
	}

	const installed = [];
	let binaryInstall;
	let serviceInstall = null;
	try {
		binaryInstall = await installFile(source, binaryPath, 0o755, dryRun);
		if (binaryInstall.installed) installed.push(binaryInstall);
		serviceInstall = servicePath && serviceSource
			? await installServiceFile(serviceSource, servicePath, serviceNode, dryRun)
			: null;
		if (serviceInstall?.installed) installed.push(serviceInstall);

		const metadata = {
			runtime: "kaos-headless-host",
			installedAt: new Date().toISOString(),
			source,
			checksumPath,
			sha256: actualSha256,
			binaryPath,
			servicePath: servicePath ?? null,
			serviceNode: serviceNode ?? null,
			dryRun,
		};
		if (!dryRun) {
			await writeMetadata(metadataPath, metadata);
		}
	} catch (err) {
		const rolledBack = await rollbackInstalledFiles(installed);
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`install failed after rolling back ${rolledBack.length} file(s): ${message}`);
	}

	console.log(JSON.stringify({
		kind: "headless-host-install",
		ok: true,
		dryRun,
		source,
		checksumPath,
		sha256: actualSha256,
		binary: binaryInstall,
		service: serviceInstall,
		serviceNode: serviceNode ?? null,
		metadataPath,
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

async function findDefaultServiceSource(source) {
	const nextToSource = join(dirname(source), "kaos-headless-host.service");
	if (await pathExists(nextToSource)) return nextToSource;
	const repoTemplate = join("deploy", "kaos-headless-host.service");
	if (await pathExists(repoTemplate)) return repoTemplate;
	return nextToSource;
}

async function readExpectedSha256(path) {
	const text = await readFile(path, "utf8");
	const match = text.match(/[a-fA-F0-9]{64}/);
	if (!match) throw new Error(`checksum file does not contain a sha256 digest: ${path}`);
	return match[0].toLowerCase();
}

async function sha256File(path) {
	const bytes = await readFile(path);
	return createHash("sha256").update(bytes).digest("hex");
}

async function installFile(source, target, mode, dryRun) {
	await assertReadable(source, "source");
	const existed = await pathExists(target);
	const backupPath = `${target}.previous`;
	if (dryRun) {
		return {
			target,
			source,
			backupPath: existed ? backupPath : null,
			installed: false,
		};
	}

	await mkdir(dirname(target), { recursive: true });
	const tempPath = `${target}.tmp-${process.pid}-${Date.now()}-${basename(source)}`;
	let movedOldTarget = false;
	try {
		await copyFile(source, tempPath);
		await chmod(tempPath, mode);
		if (existed) {
			await rm(backupPath, { force: true });
			await rename(target, backupPath);
			movedOldTarget = true;
		}
		await rename(tempPath, target);
		const installedMode = (await stat(target)).mode & 0o777;
		return {
			target,
			source,
			backupPath: existed ? backupPath : null,
			installed: true,
			mode: `0${installedMode.toString(8)}`,
		};
	} catch (err) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		if (movedOldTarget && !(await pathExists(target)) && await pathExists(backupPath)) {
			await rename(backupPath, target).catch(() => undefined);
		}
		throw err;
	}
}

async function installServiceFile(source, target, serviceNode, dryRun) {
	if (!serviceNode) return installFile(source, target, 0o644, dryRun);
	await assertReadable(source, "service source");
	const content = rewriteServiceNode(await readFile(source, "utf8"), serviceNode);
	return installTextFile({
		source,
		target,
		mode: 0o644,
		dryRun,
		content,
		extra: { serviceNode },
	});
}

async function installTextFile({ source, target, mode, dryRun, content, extra = {} }) {
	const existed = await pathExists(target);
	const backupPath = `${target}.previous`;
	if (dryRun) {
		return {
			target,
			source,
			backupPath: existed ? backupPath : null,
			installed: false,
			...extra,
		};
	}

	await mkdir(dirname(target), { recursive: true });
	const tempPath = `${target}.tmp-${process.pid}-${Date.now()}-${basename(source)}`;
	let movedOldTarget = false;
	try {
		await writeFile(tempPath, content, "utf8");
		await chmod(tempPath, mode);
		if (existed) {
			await rm(backupPath, { force: true });
			await rename(target, backupPath);
			movedOldTarget = true;
		}
		await rename(tempPath, target);
		const installedMode = (await stat(target)).mode & 0o777;
		return {
			target,
			source,
			backupPath: existed ? backupPath : null,
			installed: true,
			mode: `0${installedMode.toString(8)}`,
			...extra,
		};
	} catch (err) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		if (movedOldTarget && !(await pathExists(target)) && await pathExists(backupPath)) {
			await rename(backupPath, target).catch(() => undefined);
		}
		throw err;
	}
}

function rewriteServiceNode(text, serviceNode) {
	assertServiceNodePath(serviceNode);
	const commands = [];
	const failures = [];
	const rewritten = text.replace(/^(\s*(ExecStart(?:Pre)?)=)(.*)$/gm, (line, prefix, key, rest) => {
		commands.push(key);
		const match = rest.match(/^(\s*)([^\s]+)(\s+--(?:\s+|$).*)$/);
		if (!match) {
			failures.push(key);
			return line;
		}
		return `${prefix}${match[1]}${systemdExecutablePrefix(match[2])}${serviceNode}${match[3]}`;
	});
	if (!commands.includes("ExecStart")) {
		throw new Error("service source does not contain ExecStart=, cannot apply --service-node");
	}
	if (failures.length > 0) {
		throw new Error(`service source has unsupported ${failures.join(", ")} command form; expected "<node> -- <script>" for --service-node`);
	}
	return rewritten;
}

function assertServiceNodePath(serviceNode) {
	if (!serviceNode.startsWith("/")) {
		throw new Error(`--service-node must resolve to an absolute path: ${serviceNode}`);
	}
	if (/\s/.test(serviceNode)) {
		throw new Error(`--service-node cannot contain whitespace because systemd ExecStart parsing would be ambiguous: ${serviceNode}`);
	}
}

function systemdExecutablePrefix(command) {
	return command.match(/^[-+!@:]+/)?.[0] ?? "";
}

async function rollbackInstalledFiles(entries) {
	const rolledBack = [];
	const stamp = `${Date.now()}-${process.pid}`;
	for (const entry of entries.slice().reverse()) {
		try {
			if (entry.backupPath) {
				const failedPath = `${entry.target}.failed-install-${stamp}`;
				if (await pathExists(entry.target)) {
					await rm(failedPath, { force: true });
					await rename(entry.target, failedPath);
				}
				if (await pathExists(entry.backupPath)) {
					await rename(entry.backupPath, entry.target);
				}
			} else if (await pathExists(entry.target)) {
				await rm(entry.target, { force: true });
			}
			rolledBack.push({ target: entry.target, restored: entry.backupPath !== null });
		} catch (err) {
			rolledBack.push({
				target: entry.target,
				restored: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return rolledBack;
}

async function writeMetadata(path, metadata) {
	await mkdir(dirname(path), { recursive: true });
	const backupPath = `${path}.previous`;
	const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${basename(path)}`;
	const existed = await pathExists(path);
	let movedOldTarget = false;
	try {
		await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
		if (existed) {
			await rm(backupPath, { force: true });
			await rename(path, backupPath);
			movedOldTarget = true;
		}
		await rename(tempPath, path);
	} catch (err) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		if (movedOldTarget && !(await pathExists(path)) && await pathExists(backupPath)) {
			await rename(backupPath, path).catch(() => undefined);
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
	console.log(`Usage: node scripts/install-headless-host.mjs [options]

Options:
  --source <path>         Built or downloaded kaos-headless-host.mjs.
                          Defaults to dist/kaos-headless-host.mjs.
  --checksum <path>       sha256 file for --source. Defaults to <source>.sha256.
  --install-dir <path>    Directory for the installed binary. Defaults to /opt/kaos.
  --binary-name <name>    Installed binary name. Defaults to kaos-headless-host.mjs.
  --service-source <path> systemd service template to install when --service-path is set.
  --service-path <path>   systemd service destination, for example
                          /etc/systemd/system/kaos-headless-host.service.
  --service-node <path>   Rewrite ExecStart/ExecStartPre to use this Node binary.
                          Service commands must use "<node> -- <script>" form.
  --metadata-path <path>  Install metadata JSON. Defaults below --install-dir.
  --dry-run               Verify checksum and print the planned install without writing.
  --help, -h              Print this help.
`);
}

main().catch((err) => {
	console.error(JSON.stringify({
		kind: "headless-host-install",
		ok: false,
		error: err instanceof Error ? err.message : String(err),
	}));
	process.exitCode = 1;
});
