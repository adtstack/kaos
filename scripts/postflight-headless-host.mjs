#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}
	for (const legacy of ["token", "token-file", "token-stdin"]) {
		if (raw[legacy] !== undefined) throw new Error(`--${legacy} is no longer supported; use --identity-file and an approved device.`);
	}

	const binary = resolve(raw.binary ?? "/opt/kaos/kaos-headless-host.mjs");
	const vault = resolve(raw.vault ?? "/srv/kaos/vault");
	const dataFile = resolve(raw["data-file"] ?? "/var/lib/kaos-headless/data.json");
	const lockFile = resolve(raw["lock-file"] ?? "/run/kaos-headless/kaos.lock");
	const envFile = resolve(raw["env-file"] ?? "/etc/kaos/headless.env");
	const initialEnv = await readEnvFile(envFile).catch(() => ({}));
	const identityFile = resolve(raw["identity-file"] ?? initialEnv.KAOS_IDENTITY_FILE ?? "/var/lib/kaos-headless/device-identity.json");
	const smokeScript = resolve(raw["smoke-script"] ?? defaultSmokeScriptPath());
	const smokeWorkDir = raw["smoke-work-dir"] ? resolve(raw["smoke-work-dir"]) : undefined;
	const serviceFile = raw["service-file"]
		? resolve(raw["service-file"])
		: await defaultServiceFile();
	const metadataPath = raw["metadata-path"]
		? resolve(raw["metadata-path"])
		: resolve(join(dirname(binary), ".kaos-headless-install.json"));
	const service = raw.service ?? inferServiceName(serviceFile) ?? "kaos-headless-host";
	const nodeBin = raw.node ?? await readServiceNode(serviceFile) ?? process.execPath;
	const serviceUser = await readServiceUser(serviceFile);
	const serviceGroup = await readServiceGroup(serviceFile);
	const systemctl = raw.systemctl ?? "systemctl";
	const explicitRunuser = raw.runuser !== undefined;
	const smokeUser = raw["no-smoke-user"] === "true"
		? undefined
		: raw["smoke-user"] ?? defaultSmokeUser(serviceUser, explicitRunuser);
	const smokeGroup = smokeUser && smokeUser === serviceUser ? serviceGroup : undefined;
	const runuser = raw.runuser ?? "runuser";
	const timeoutMs = parsePositiveInt(raw["timeout-ms"], 120_000, "timeout-ms");
	const minNodeMajor = parsePositiveInt(raw["min-node-major"], 20, "min-node-major");
	const checkOnly = raw["check-only"] === "true";
	const verifyRunning = raw["verify-running"] === "true";
	if (checkOnly && verifyRunning) {
		throw new Error("--verify-running cannot be combined with --check-only.");
	}
	if (verifyRunning && raw["skip-systemctl"] === "true") {
		throw new Error("--verify-running requires systemctl; remove --skip-systemctl.");
	}
	const skipSystemctl = checkOnly || raw["skip-systemctl"] === "true";
	const skipSmoke = checkOnly || raw["skip-smoke"] === "true";
	const skipServiceFileCheck = raw["skip-service-file-check"] === "true";
	const skipMetadataCheck = raw["skip-metadata-check"] === "true";
	const skipServiceIdentityCheck = raw["skip-service-identity-check"] === "true";
	const requireServiceIdentityCheck = raw["require-service-identity-check"] === "true" || process.getuid?.() === 0;
	const skipServiceAccessCheck = raw["skip-service-access-check"] === "true";
	const requireServiceAccessCheck = raw["require-service-access-check"] === "true" || process.getuid?.() === 0;
	let redactor = redactNoop;

	const result = {
		kind: "headless-host-postflight",
		ok: false,
		service,
		binary,
		vault,
		dataFile,
		lockFile,
		envFile,
		serviceFile: serviceFile ?? null,
		serviceUser: serviceUser ?? null,
		serviceGroup: serviceGroup ?? null,
		metadataPath,
		checkOnly,
		verifyRunning,
		nodeBin,
		nodeVersion: null,
		minNodeMajor,
		nodeVersionCheck: null,
		identityFile,
		smokeUser: smokeUser ?? null,
		smokeGroup: smokeGroup ?? null,
		smokeWorkDir: smokeWorkDir ?? null,
		bootServiceEnabled: null,
		serviceIdentityChecks: null,
		serviceAccessChecks: null,
		managedDirectoryPreparation: null,
		authFileChecks: null,
		metadataChecks: null,
		serviceFileChecks: null,
		doctor: null,
		systemctl: [],
		smoke: null,
		readiness: null,
	};

	try {
		await assertPath(binary, "headless binary");
		await assertPath(vault, "vault");
		result.serviceIdentityChecks = skipServiceIdentityCheck
			? null
			: checkServiceIdentity({
				serviceUser,
				serviceGroup,
				required: requireServiceIdentityCheck,
			});
		result.managedDirectoryPreparation = await prepareManagedDirectories({
			serviceFile,
			serviceUser,
			serviceGroup,
			dataFile,
			lockFile,
		});
		await assertPath(dirname(dataFile), "data directory");
		await assertPath(dirname(lockFile), "lock directory");
		await assertPath(envFile, "env file");
		await assertPath(identityFile, "device identity file");
		if (!skipSmoke) await assertPath(smokeScript, "smoke script");
		result.authFileChecks = await checkAuthFiles({ envFile, identityFile });
		result.serviceAccessChecks = skipServiceAccessCheck
			? null
			: checkServiceAccess({
				serviceUser,
				serviceGroup,
				required: requireServiceAccessCheck,
				runuser,
				timeoutMs,
				nodeBin,
				binary,
				vault,
				dataFile,
				lockFile,
				envFile,
				identityFile,
				smokeScript,
				smokeWorkDir,
				skipSmoke,
			});
		result.metadataChecks = skipMetadataCheck
			? null
			: await checkInstallMetadata({
				metadataPath,
				required: raw["metadata-path"] !== undefined,
				binary,
				serviceFile,
			});

		const envConfig = await readEnvFile(envFile);
		const persistedConfig = await readJsonIfExists(dataFile);
		const childEnv = {
			...process.env,
			...envConfig,
		};
		if (hasConfiguredValue(childEnv.KAOS_SYNC_TOKEN) || hasConfiguredValue(childEnv.SYNC_TOKEN)) {
			throw new PostflightStepError("preflight:legacy-credential", "Legacy shared credential environment variables are not permitted.", {});
		}
		if (hasConfiguredValue(persistedConfig.token)) {
			throw new PostflightStepError("preflight:legacy-credential", "A legacy shared credential remains in data.json. Remove it before deploying.", {});
		}
		const nodeVersion = runCommand(nodeBin, ["--version"], { env: childEnv, timeout: timeoutMs, label: "node version" });
		result.nodeVersion = nodeVersion.stdout;
		result.nodeVersionCheck = checkNodeVersion(nodeVersion.stdout, minNodeMajor);
		if (!result.nodeVersionCheck.ok) {
			throw new PostflightStepError("node-version", `Node ${minNodeMajor} or newer is required; ${nodeBin} reported ${nodeVersion.stdout || "(empty)"}`, result.nodeVersionCheck);
		}
		result.serviceFileChecks = skipServiceFileCheck
			? null
			: await checkServiceFile({
				serviceFile,
				nodeBin,
				binary,
				vault,
				dataFile,
				lockFile,
				envFile,
				identityFile,
			});

		result.doctor = runJson(nodeBin, [
			"--",
			binary,
			"--doctor",
			"--require-sync-config",
			"--skip-worker-capabilities",
			"--vault",
			vault,
			"--data-file",
			dataFile,
			"--lock-file",
			lockFile,
			"--identity-file",
			identityFile,
		], {
			env: childEnv,
			timeout: timeoutMs,
			label: "doctor",
		});

		if (!skipSystemctl) {
			if (!verifyRunning) {
				result.systemctl.push(runCommand(systemctl, ["daemon-reload"], { timeout: timeoutMs, label: "systemctl daemon-reload" }));
				result.systemctl.push(runCommand(systemctl, ["restart", service], { timeout: timeoutMs, label: `systemctl restart ${service}` }));
			} else {
				result.bootServiceEnabled = runCommand(systemctl, ["is-enabled", "--quiet", service], { timeout: timeoutMs, label: `systemctl is-enabled ${service}` });
			}
			result.systemctl.push(runCommand(systemctl, ["is-active", "--quiet", service], { timeout: timeoutMs, label: `systemctl is-active ${service}` }));
		}

		result.smoke = skipSmoke
			? null
			: runJson(...buildSmokeCommand({
				nodeBin,
				smokeScript,
				binary,
				vault,
				dataFile,
				lockFile,
				envFile,
				identityFile,
				timeoutMs,
				smokeUser,
				smokeGroup,
				runuser,
				smokeWorkDir,
			}), {
				env: childEnv,
				timeout: timeoutMs + 10_000,
				label: "smoke",
			});

		result.readiness = summarizeReadiness(result, {
			checkOnly,
			verifyRunning,
			skipSystemctl,
			skipSmoke,
		});
		result.ok = true;
		console.log(JSON.stringify(redactObject(result, redactor), null, 2));
	} catch (err) {
		const failure = describeFailure(err);
		console.error(JSON.stringify(redactObject({
			...result,
			ok: false,
			failedStage: failure.stage,
			error: failure.message,
			failure,
		}, redactor), null, 2));
		process.exitCode = 1;
	}
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = "true";
			continue;
		}
		if (arg === "--skip-systemctl") {
			out["skip-systemctl"] = "true";
			continue;
		}
		if (arg === "--skip-smoke") {
			out["skip-smoke"] = "true";
			continue;
		}
		if (arg === "--check-only") {
			out["check-only"] = "true";
			continue;
		}
		if (arg === "--verify-running") {
			out["verify-running"] = "true";
			continue;
		}
		if (arg === "--no-smoke-user") {
			out["no-smoke-user"] = "true";
			continue;
		}
		if (arg === "--skip-service-file-check") {
			out["skip-service-file-check"] = "true";
			continue;
		}
		if (arg === "--skip-metadata-check") {
			out["skip-metadata-check"] = "true";
			continue;
		}
		if (arg === "--skip-service-identity-check") {
			out["skip-service-identity-check"] = "true";
			continue;
		}
		if (arg === "--require-service-identity-check") {
			out["require-service-identity-check"] = "true";
			continue;
		}
		if (arg === "--skip-service-access-check") {
			out["skip-service-access-check"] = "true";
			continue;
		}
		if (arg === "--require-service-access-check") {
			out["require-service-access-check"] = "true";
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

function buildSmokeCommand({ nodeBin, smokeScript, binary, vault, dataFile, lockFile, envFile, identityFile, timeoutMs, smokeUser, smokeGroup, runuser }) {
	const smokeArgs = [
		"--",
		smokeScript,
		"--binary",
		binary,
		"--vault",
		vault,
		"--data-file",
		dataFile,
		"--lock-file",
		lockFile,
		"--env-file",
		envFile,
		"--identity-file",
		identityFile,
		"--require-lock",
		"--timeout-ms",
		String(timeoutMs),
	];
	if (!smokeUser) return [nodeBin, smokeArgs];
	return [runuser, [...runuserIdentityArgs(smokeUser, smokeGroup), "--", nodeBin, ...smokeArgs]];
}

async function readEnvFile(path) {
	const text = await readFile(path, "utf8");
	const out = {};
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

async function readJsonIfExists(path) {
	try {
		const value = JSON.parse(await readFile(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

async function checkAuthFiles({ envFile, identityFile }) {
	const envStat = await stat(envFile);
	const envMode = envStat.mode & 0o777;
	const envConfig = await readEnvFile(envFile);
	const envContainsToken = hasConfiguredValue(envConfig.KAOS_SYNC_TOKEN) || hasConfiguredValue(envConfig.SYNC_TOKEN);
	const envChecks = [
		{
			name: "env-file-not-world-writable",
			expected: true,
			actual: (envMode & 0o002) === 0,
			ok: (envMode & 0o002) === 0,
		},
		{
			name: "env-file-not-group-writable",
			expected: true,
			actual: (envMode & 0o020) === 0,
			ok: (envMode & 0o020) === 0,
		},
		{
			name: "env-file-not-executable",
			expected: true,
			actual: (envMode & 0o111) === 0,
			ok: (envMode & 0o111) === 0,
		},
		{
			name: "env-file-no-legacy-credential",
			expected: true,
			actual: !envContainsToken,
			ok: !envContainsToken,
		},
	];
	const identityStat = await lstat(identityFile);
	const identityMode = identityStat.mode & 0o777;
	const identityChecks = [
		{
			name: "identity-file-regular",
			expected: true,
			actual: identityStat.isFile() && !identityStat.isSymbolicLink(),
			ok: identityStat.isFile() && !identityStat.isSymbolicLink(),
		},
		{
			name: "identity-file-mode-0600",
			expected: true,
			actual: (identityMode & 0o077) === 0,
			ok: (identityMode & 0o077) === 0,
		},
	];
	const payload = {
		ok: envChecks.every((check) => check.ok) && identityChecks.every((check) => check.ok),
		envFile: {
			path: envFile,
			mode: `0${envMode.toString(8).padStart(3, "0")}`,
			containsLegacyCredential: envContainsToken,
		},
		identityFile: {
			path: identityFile,
			mode: `0${identityMode.toString(8).padStart(3, "0")}`,
		},
		checks: [...envChecks, ...identityChecks],
	};
	if (!payload.ok) {
		const identityFailed = identityChecks.some((check) => !check.ok);
		const stage = identityFailed ? "preflight:identity-file-permissions" : "preflight:env-file";
		const path = identityFailed ? identityFile : envFile;
		throw new PostflightStepError(stage, `authentication file checks failed: ${path}`, payload);
	}
	return payload;
}

function hasConfiguredValue(value) {
	return typeof value === "string" && value.length > 0;
}

function checkServiceIdentity({ serviceUser, serviceGroup, required }) {
	if (!required) {
		return {
			ok: true,
			required: false,
			skipped: true,
			reason: "service identity check is enforced when postflight runs as root or --require-service-identity-check is set",
			checks: [],
		};
	}
	const checks = [
		{
			name: "service-user-declared",
			expected: "non-root user",
			actual: serviceUser ?? null,
			ok: Boolean(serviceUser && serviceUser !== "root" && serviceUser !== "0"),
		},
	];
	if (serviceUser) {
		checks.push(runIdentityCheck("service-user-exists", "id", ["-u", serviceUser], serviceUser));
	}
	if (serviceGroup) {
		checks.push(runIdentityCheck("service-group-exists", "getent", ["group", serviceGroup], serviceGroup));
	}
	const failed = checks.filter((check) => !check.ok);
	const payload = {
		ok: failed.length === 0,
		required: true,
		skipped: false,
		serviceUser: serviceUser ?? null,
		serviceGroup: serviceGroup ?? null,
		checks,
	};
	if (failed.length > 0) {
		throw new PostflightStepError("service-identity", `service identity is not ready: ${failed.map((check) => check.name).join(", ")}`, payload);
	}
	return payload;
}

function runIdentityCheck(name, command, args, expected) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
	});
	return {
		name,
		expected,
		actual: result.status === 0 ? (result.stdout.trim() || expected) : (result.stderr.trim() || result.error?.message || `status ${result.status}`),
		ok: result.status === 0,
	};
}

function checkServiceAccess({ serviceUser, serviceGroup, required, runuser, timeoutMs, nodeBin, binary, vault, dataFile, lockFile, envFile, identityFile, smokeScript, smokeWorkDir, skipSmoke }) {
	if (!required) {
		return {
			ok: true,
			required: false,
			skipped: true,
			reason: "service access check is enforced when postflight runs as root or --require-service-access-check is set",
			serviceUser: serviceUser ?? null,
			serviceGroup: serviceGroup ?? null,
			checks: [],
		};
	}
	const checks = [
		{
			name: "service-user-declared",
			expected: "non-root user",
			actual: serviceUser ?? null,
			ok: Boolean(serviceUser && serviceUser !== "root" && serviceUser !== "0"),
		},
	];
	if (serviceUser) {
		const workingDir = dirname(binary);
		if (!skipSmoke) {
			checks.push(checkSmokeWorkspaceOverlap(smokeWorkDir, vault));
		}
		for (const [name, flag, path] of [
			["service-node-readable", "-r", nodeBin],
			["service-node-executable", "-x", nodeBin],
			["service-working-dir-readable", "-r", workingDir],
			["service-working-dir-searchable", "-x", workingDir],
			["service-binary-readable", "-r", binary],
			["service-binary-executable", "-x", binary],
			["service-vault-readable", "-r", vault],
			["service-vault-writable", "-w", vault],
			["service-vault-searchable", "-x", vault],
			["service-data-dir-readable", "-r", dirname(dataFile)],
			["service-data-dir-writable", "-w", dirname(dataFile)],
			["service-data-dir-searchable", "-x", dirname(dataFile)],
			["service-lock-dir-readable", "-r", dirname(lockFile)],
			["service-lock-dir-writable", "-w", dirname(lockFile)],
			["service-lock-dir-searchable", "-x", dirname(lockFile)],
			["service-env-readable", "-r", envFile],
			["service-identity-readable", "-r", identityFile],
			...(!skipSmoke ? [
				["service-smoke-script-readable", "-r", smokeScript],
				...smokeWorkspaceAccessChecks(smokeWorkDir),
			] : []),
			...existingFileAccessChecks("service-data-file", dataFile),
			...existingFileAccessChecks("service-lock-file", lockFile),
		]) {
			checks.push(runServiceAccessCheck(name, runuser, serviceUser, serviceGroup, flag, path, timeoutMs));
		}
	}
	const failed = checks.filter((check) => !check.ok);
	const payload = {
		ok: failed.length === 0,
		required: true,
		skipped: false,
		serviceUser: serviceUser ?? null,
		serviceGroup: serviceGroup ?? null,
		runuser,
		checks,
	};
	if (failed.length > 0) {
		throw new PostflightStepError("service-access", `service user cannot access required files: ${failed.map((check) => check.name).join(", ")}`, payload);
	}
	return payload;
}

function checkSmokeWorkspaceOverlap(smokeWorkDir, vault) {
	if (!smokeWorkDir) {
		return {
			name: "service-smoke-work-dir-outside-vault",
			expected: true,
			actual: true,
			ok: true,
		};
	}
	const peerVault = join(smokeWorkDir, "peer-vault");
	const ok = !pathsOverlap(vault, peerVault);
	return {
		name: "service-smoke-work-dir-outside-vault",
		expected: true,
		actual: ok,
		ok,
		vault,
		smokeWorkDir,
		peerVault,
	};
}

function smokeWorkspaceAccessChecks(smokeWorkDir) {
	if (!smokeWorkDir) {
		return [
			["service-smoke-temp-dir-writable", "-w", tmpdir()],
			["service-smoke-temp-dir-searchable", "-x", tmpdir()],
		];
	}
	const target = existsSync(smokeWorkDir) ? smokeWorkDir : nearestExistingAncestor(smokeWorkDir);
	return [
		["service-smoke-work-dir-writable", "-w", target],
		["service-smoke-work-dir-searchable", "-x", target],
	];
}

function pathsOverlap(a, b) {
	return pathCovers(a, b) || pathCovers(b, a);
}

function nearestExistingAncestor(path) {
	let current = path;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return current;
		current = parent;
	}
	return current;
}

function existingFileAccessChecks(name, path) {
	if (!existsSync(path)) return [];
	return [
		[`${name}-readable`, "-r", path],
		[`${name}-writable`, "-w", path],
	];
}

function runServiceAccessCheck(name, runuser, serviceUser, serviceGroup, flag, path, timeoutMs) {
	const result = spawnSync(runuser, [...runuserIdentityArgs(serviceUser, serviceGroup), "--", "test", flag, path], {
		encoding: "utf8",
		timeout: timeoutMs,
	});
	const stdout = (result.stdout ?? "").trim();
	const stderr = (result.stderr ?? "").trim();
	return {
		name,
		path,
		expected: true,
		actual: result.status === 0 ? true : (stderr || stdout || result.error?.message || `status ${result.status}`),
		ok: result.status === 0,
	};
}

function runuserIdentityArgs(user, group) {
	return group ? ["-u", user, "-g", group] : ["-u", user];
}

async function prepareManagedDirectories({ serviceFile, serviceUser, serviceGroup, dataFile, lockFile }) {
	if (!serviceFile) return null;
	let logicalLines;
	try {
		logicalLines = joinSystemdContinuations(await readFile(serviceFile, "utf8"));
	} catch {
		return null;
	}
	const runtimeDirectories = findUnitValues(logicalLines, "RuntimeDirectory").flatMap((value) => splitSystemdCommand(value));
	const stateDirectories = findUnitValues(logicalLines, "StateDirectory").flatMap((value) => splitSystemdCommand(value));
	const targets = [
		{
			name: "lock-dir",
			path: dirname(lockFile),
			covered: directoryEntriesCover(runtimeDirectories, "/run", dirname(lockFile)),
		},
		{
			name: "data-dir",
			path: dirname(dataFile),
			covered: directoryEntriesCover(stateDirectories, "/var/lib", dirname(dataFile)),
		},
	];
	const created = [];
	for (const target of targets) {
		const existed = await pathExists(target.path);
		if (existed || !target.covered) {
			created.push({
				name: target.name,
				path: target.path,
				created: false,
				reason: existed ? "already present" : "not covered by systemd managed directory",
			});
			continue;
		}
		try {
			await mkdir(target.path, { recursive: true });
			await chmod(target.path, 0o755);
			const chowned = await chownForServiceUser(target.path, serviceUser, serviceGroup);
			created.push({
				name: target.name,
				path: target.path,
				created: true,
				chowned,
			});
		} catch (err) {
			throw new PostflightStepError("preflight:managed-directory", `failed to prepare ${target.name} at ${target.path}: ${err instanceof Error ? err.message : String(err)}`, {
				target,
				serviceUser: serviceUser ?? null,
				serviceGroup: serviceGroup ?? null,
			});
		}
	}
	return {
		ok: true,
		serviceFile,
		serviceUser: serviceUser ?? null,
		serviceGroup: serviceGroup ?? null,
		entries: created,
	};
}

async function chownForServiceUser(path, serviceUser, serviceGroup) {
	if (process.getuid?.() !== 0 || !serviceUser) return false;
	const owner = `${serviceUser}:${serviceGroup || serviceUser}`;
	const result = spawnSync("chown", [owner, path], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `chown exited with status ${result.status}`);
	}
	return true;
}

async function checkInstallMetadata({ metadataPath, required, binary, serviceFile }) {
	if (!(await pathExists(metadataPath))) {
		if (required) {
			throw new PostflightStepError("metadata", `install metadata does not exist: ${metadataPath}`, {
				metadataPath,
			});
		}
		return null;
	}
	let metadata;
	try {
		metadata = JSON.parse(await readFile(metadataPath, "utf8"));
	} catch (err) {
		throw new PostflightStepError("metadata", `failed to read install metadata ${metadataPath}: ${err instanceof Error ? err.message : String(err)}`, {
			metadataPath,
		});
	}
	const kind = metadata?.kind ?? metadata?.runtime ?? null;
	const releaseMetadata = metadata?.kind === "headless-host-release-install";
	const installMetadata = metadata?.runtime === "kaos-headless-host" && typeof metadata?.sha256 === "string";
	if (!releaseMetadata && !installMetadata) {
		return {
			metadataPath,
			ok: true,
			supported: false,
			kind,
			checks: [
				{
					name: "metadata-schema-legacy",
					expected: "known headless metadata or legacy metadata",
					actual: kind,
					ok: true,
				},
			],
		};
	}

	const expectedBinaryPath = releaseMetadata
		? metadata.install?.binary?.target ?? metadata.install?.binaryPath
		: metadata.binaryPath;
	const expectedBinarySha256 = releaseMetadata ? metadata.install?.sha256 : metadata.sha256;
	const expectedServicePath = releaseMetadata
		? metadata.install?.service?.target ?? metadata.servicePath ?? null
		: metadata.servicePath ?? null;
	const actualBinarySha256 = await sha256File(binary);
	const checks = [
		{
			name: "metadata-binary-path",
			expected: binary,
			actual: expectedBinaryPath ?? null,
			ok: expectedBinaryPath === binary,
		},
		{
			name: "metadata-binary-sha256",
			expected: expectedBinarySha256 ?? null,
			actual: actualBinarySha256,
			ok: expectedBinarySha256 === actualBinarySha256,
		},
	];
	if (serviceFile) {
		checks.push({
			name: "metadata-service-path",
			expected: serviceFile,
			actual: expectedServicePath,
			ok: expectedServicePath === serviceFile,
		});
	}
	if (releaseMetadata && Array.isArray(metadata.helpers)) {
		for (const helper of metadata.helpers) {
			if (!helper?.target || !helper?.installedSha256) continue;
			const actual = await pathExists(helper.target) ? await sha256File(helper.target) : null;
			checks.push({
				name: `metadata-helper-${basename(helper.target)}-sha256`,
				expected: helper.installedSha256,
				actual,
				ok: actual === helper.installedSha256,
			});
		}
	}
	const failed = checks.filter((check) => !check.ok);
	const payload = {
		metadataPath,
		ok: failed.length === 0,
		supported: true,
		kind,
		checks,
	};
	if (failed.length > 0) {
		throw new PostflightStepError("metadata", `install metadata does not match installed files: ${failed.map((check) => check.name).join(", ")}`, payload);
	}
	return payload;
}

async function sha256File(path) {
	const bytes = await readFile(path);
	return createHash("sha256").update(bytes).digest("hex");
}

async function checkServiceFile({ serviceFile, nodeBin, binary, vault, dataFile, lockFile, envFile }) {
	if (!serviceFile) return null;
	let logicalLines;
	try {
		logicalLines = joinSystemdContinuations(await readFile(serviceFile, "utf8"));
	} catch (err) {
		throw new PostflightStepError("service-file", `failed to read service file ${serviceFile}: ${err instanceof Error ? err.message : String(err)}`, {
			serviceFile,
		});
	}
	const execStart = findUnitValue(logicalLines, "ExecStart");
	const execStartPre = findUnitValue(logicalLines, "ExecStartPre");
	const serviceUser = findUnitValue(logicalLines, "User");
	const workingDirectory = findUnitValue(logicalLines, "WorkingDirectory");
	const envFiles = findUnitValues(logicalLines, "EnvironmentFile").map((value) => value.replace(/^-/, ""));
	const runtimeDirectories = findUnitValues(logicalLines, "RuntimeDirectory").flatMap((value) => splitSystemdCommand(value));
	const stateDirectories = findUnitValues(logicalLines, "StateDirectory").flatMap((value) => splitSystemdCommand(value));
	const restart = findUnitValue(logicalLines, "Restart");
	const restartSec = findUnitValue(logicalLines, "RestartSec");
	const protectSystem = findUnitValue(logicalLines, "ProtectSystem");
	const protectHome = findUnitValue(logicalLines, "ProtectHome");
	const readWritePaths = findUnitValues(logicalLines, "ReadWritePaths")
		.flatMap((value) => splitSystemdCommand(value))
		.map((value) => value.replace(/^-/, ""))
		.filter(Boolean);
	const checks = [
		{
			name: "environment-file",
			expected: envFile,
			actual: envFiles,
			ok: envFiles.includes(envFile),
		},
		{
			name: "service-user-non-root",
			expected: "non-root user",
			actual: serviceUser || null,
			ok: serviceUser.length > 0 && serviceUser !== "root" && serviceUser !== "0",
		},
		{
			name: "working-directory",
			expected: dirname(binary),
			actual: workingDirectory || null,
			ok: !workingDirectory || resolve(workingDirectory) === resolve(dirname(binary)),
		},
		{
			name: "restart-on-failure",
			expected: "on-failure",
			actual: restart,
			ok: restart === "on-failure",
		},
		{
			name: "restart-sec-positive",
			expected: "positive systemd duration",
			actual: restartSec,
			ok: isPositiveSystemdDuration(restartSec),
		},
		{
			name: "protect-system-strict",
			expected: "strict",
			actual: protectSystem,
			ok: protectSystem === "strict",
		},
		{
			name: "protect-home-vault-access",
			expected: "ProtectHome disabled when vault is below /home, /root, or /run/user",
			actual: protectHome || null,
			ok: protectHomeAllowsVault(protectHome, vault),
		},
		{
			name: "runtime-directory-lock-dir",
			expected: dirname(lockFile),
			actual: runtimeDirectories,
			ok: directoryEntriesCover(runtimeDirectories, "/run", dirname(lockFile)),
		},
		{
			name: "state-directory-data-dir",
			expected: dirname(dataFile),
			actual: stateDirectories,
			ok: directoryEntriesCover(stateDirectories, "/var/lib", dirname(dataFile)),
		},
		...checkWritablePaths(readWritePaths, [
			["vault", vault],
			["data-dir", dirname(dataFile)],
			["lock-dir", dirname(lockFile)],
		]),
		...checkCommand("exec-start", execStart, {
			nodeBin,
			binary,
			vault,
			dataFile,
			lockFile,
			requireDoctor: false,
		}),
		...checkCommand("exec-start-pre", execStartPre, {
			nodeBin,
			binary,
			vault,
			dataFile,
			lockFile,
			requireDoctor: true,
		}),
	];
	const failed = checks.filter((check) => !check.ok);
	const payload = {
		serviceFile,
		ok: failed.length === 0,
		checks,
	};
	if (failed.length > 0) {
		throw new PostflightStepError("service-file", `service file does not match postflight configuration: ${failed.map((check) => check.name).join(", ")}`, payload);
	}
	return payload;
}

function isPositiveSystemdDuration(value) {
	const trimmed = String(value ?? "").trim().toLowerCase();
	if (!trimmed || trimmed === "infinity") return false;
	const match = trimmed.match(/^(\d+(?:\.\d+)?)(?:\s*(ms|msec|s|sec|second|seconds|min|minute|minutes|m|h|hr|hour|hours))?$/);
	return match ? Number.parseFloat(match[1]) > 0 : false;
}

function protectHomeAllowsVault(protectHome, vault) {
	if (!pathUnderAny(vault, protectedHomeRoots())) return true;
	return !protectHome || ["false", "no", "off", "0"].includes(protectHome.trim().toLowerCase());
}

function protectedHomeRoots() {
	const roots = ["/home", "/root", "/run/user"];
	if (process.platform === "darwin") roots.push("/Users");
	const extraRoots = (process.env.KAOS_POSTFLIGHT_PROTECT_HOME_ROOTS ?? "")
		.split(":")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return [...roots, ...extraRoots];
}

function pathUnderAny(path, roots) {
	return roots.some((root) => pathCovers(root, path));
}

function findUnitValue(lines, key) {
	const prefix = `${key}=`;
	const line = lines.find((item) => item.trim().startsWith(prefix));
	return line ? line.trim().slice(prefix.length).trim() : "";
}

function findUnitValues(lines, key) {
	const prefix = `${key}=`;
	return lines
		.filter((item) => item.trim().startsWith(prefix))
		.map((item) => item.trim().slice(prefix.length).trim())
		.filter(Boolean);
}

function checkCommand(label, command, expected) {
	const tokens = splitSystemdCommand(command);
	const node = tokens[0]?.replace(/^[-+!@:]+/, "") ?? "";
	const hasNodeArgumentSeparator = tokens[1] === "--";
	const binary = tokens[hasNodeArgumentSeparator ? 2 : 1] ?? "";
	const checks = [
		{
			name: `${label}-present`,
			expected: true,
			actual: command.length > 0,
			ok: command.length > 0,
		},
		{
			name: `${label}-node`,
			expected: expected.nodeBin,
			actual: node,
			ok: node === expected.nodeBin,
		},
		{
			name: `${label}-node-argument-separator`,
			expected: "--",
			actual: tokens[1] ?? "",
			ok: hasNodeArgumentSeparator,
		},
		{
			name: `${label}-binary`,
			expected: expected.binary,
			actual: binary,
			ok: binary === expected.binary,
		},
	];
	for (const [flag, value] of [
		["--vault", expected.vault],
		["--data-file", expected.dataFile],
		["--lock-file", expected.lockFile],
	]) {
		checks.push({
			name: `${label}-${flag.slice(2)}`,
			expected: value,
			actual: valueAfterFlag(tokens, flag),
			ok: valueAfterFlag(tokens, flag) === value,
		});
	}
	for (const flag of ["--token", "--token-file", "--token-stdin"]) {
		checks.push({
			name: `${label}-no-${flag.slice(2)}`,
			expected: false,
			actual: tokens.includes(flag),
			ok: !tokens.includes(flag),
		});
	}
	if (expected.requireDoctor) {
		for (const flag of ["--doctor", "--require-sync-config", "--skip-worker-capabilities"]) {
			checks.push({
				name: `${label}-${flag.slice(2)}`,
				expected: true,
				actual: tokens.includes(flag),
				ok: tokens.includes(flag),
			});
		}
	}
	return checks;
}

function checkWritablePaths(readWritePaths, expectedPaths) {
	return expectedPaths.map(([name, expected]) => ({
		name: `read-write-paths-${name}`,
		expected,
		actual: readWritePaths,
		ok: readWritePaths.some((allowed) => pathCovers(allowed, expected)),
	}));
}

function pathCovers(allowed, expected) {
	if (!allowed.startsWith("/") || !expected.startsWith("/")) return allowed === expected;
	const resolvedAllowed = resolve(allowed);
	const resolvedExpected = resolve(expected);
	return resolvedAllowed === resolvedExpected || resolvedExpected.startsWith(`${resolvedAllowed}/`);
}

function directoryEntriesCover(entries, root, expected) {
	return entries
		.map((entry) => entry.startsWith("/") ? entry : `${root}/${entry}`)
		.some((entry) => pathCovers(entry, expected));
}

function splitSystemdCommand(command) {
	const out = [];
	let current = "";
	let quote = null;
	let escaped = false;
	for (const char of command) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				out.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current.length > 0) out.push(current);
	return out;
}

function valueAfterFlag(tokens, flag) {
	const index = tokens.indexOf(flag);
	return index >= 0 ? tokens[index + 1] ?? "" : "";
}

async function defaultServiceFile() {
	const path = "/etc/systemd/system/kaos-headless-host.service";
	return await pathExists(path) ? path : undefined;
}

function inferServiceName(path) {
	if (!path) return undefined;
	const name = basename(path);
	return name.endsWith(".service") && name.length > ".service".length
		? name.slice(0, -".service".length)
		: undefined;
}

async function readServiceNode(path) {
	if (!path) return undefined;
	try {
		const logicalLines = joinSystemdContinuations(await readFile(path, "utf8"));
		const execStart = logicalLines.find((line) => line.trim().startsWith("ExecStart="));
		if (!execStart) return undefined;
		const command = execStart.trim().slice("ExecStart=".length).trim();
		const token = command.split(/\s+/)[0]?.replace(/^[-+!@:]+/, "");
		return token || undefined;
	} catch {
		return undefined;
	}
}

async function readServiceUser(path) {
	if (!path) return undefined;
	try {
		const logicalLines = joinSystemdContinuations(await readFile(path, "utf8"));
		const user = findUnitValue(logicalLines, "User");
		return user || undefined;
	} catch {
		return undefined;
	}
}

async function readServiceGroup(path) {
	if (!path) return undefined;
	try {
		const logicalLines = joinSystemdContinuations(await readFile(path, "utf8"));
		const group = findUnitValue(logicalLines, "Group");
		return group || undefined;
	} catch {
		return undefined;
	}
}

function joinSystemdContinuations(text) {
	const lines = [];
	let current = "";
	for (const rawLine of text.split(/\r?\n/)) {
		const trimmedRight = rawLine.replace(/\s+$/, "");
		if (trimmedRight.endsWith("\\")) {
			current += `${trimmedRight.slice(0, -1)} `;
			continue;
		}
		lines.push(`${current}${trimmedRight}`);
		current = "";
	}
	if (current) lines.push(current);
	return lines;
}

async function assertPath(path, label) {
	if (!existsSync(path)) throw new PostflightStepError("preflight", `${label} does not exist: ${path}`, {
		label,
		path,
	});
}

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function runJson(cmd, args, options) {
	const result = runCommand(cmd, args, options);
	try {
		return JSON.parse(result.stdout);
	} catch (err) {
		throw new PostflightStepError(options.label, `${options.label} did not print JSON: ${err instanceof Error ? err.message : String(err)}`, result);
	}
}

function runCommand(cmd, args, { env = process.env, timeout, label }) {
	const result = spawnSync(cmd, args, {
		encoding: "utf8",
		env,
		timeout,
	});
	const out = {
		label,
		command: cmd,
		args,
		status: result.status,
		signal: result.signal,
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
	};
	if (result.status !== 0) {
		throw new PostflightStepError(label, `${label} failed: ${out.stderr || out.stdout || `status ${result.status}`}`, out);
	}
	return out;
}

function summarizeReadiness(result, { checkOnly, verifyRunning, skipSystemctl, skipSmoke }) {
	const checks = [
		["service-identity", result.serviceIdentityChecks],
		["managed-directories", result.managedDirectoryPreparation],
		["authentication-files", result.authFileChecks],
		["service-access", result.serviceAccessChecks],
		["metadata", result.metadataChecks],
		["node-version", result.nodeVersionCheck],
		["service-file", result.serviceFileChecks],
		["doctor", result.doctor],
	];
	const completed = checks
		.filter(([, value]) => value?.ok === true)
		.map(([name]) => name);
	const skipped = checks
		.filter(([, value]) => value === null || value?.skipped === true || value?.supported === false)
		.map(([name]) => name);
	const preRestartReady = checks.every(([, value]) => isReadinessCheckReady(value));
	if (skipSystemctl) skipped.push("systemctl");
	if (skipSmoke) skipped.push("smoke");
	return {
		ok: true,
		mode: checkOnly ? "check-only" : (verifyRunning ? "verify-running" : (skipSystemctl ? "no-systemctl" : (skipSmoke ? "no-smoke" : "full"))),
		preRestartReady,
		bootServiceEnabled: verifyRunning ? result.bootServiceEnabled?.status === 0 : null,
		liveServiceVerified: !skipSystemctl && result.systemctl.some((check) => check.args[0] === "is-active" && check.status === 0),
		syncSmokeVerified: !skipSmoke && result.smoke?.ok === true,
		completed,
		skipped,
	};
}

function isReadinessCheckReady(value) {
	return value === null || value?.skipped === true || value?.supported === false || value?.ok === true;
}

class PostflightStepError extends Error {
	constructor(stage, message, detail = null) {
		super(message);
		this.stage = stage;
		this.detail = detail;
	}
}

function describeFailure(err) {
	if (err instanceof PostflightStepError) {
		return {
			stage: err.stage,
			message: err.message,
			detail: err.detail,
		};
	}
	return {
		stage: "postflight",
		message: err instanceof Error ? err.message : String(err),
		detail: null,
	};
}

function redactNoop(text) {
	return String(text);
}

function redactObject(value, redactor) {
	if (typeof value === "string") return redactor(value);
	if (Array.isArray(value)) return value.map((item) => redactObject(item, redactor));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObject(item, redactor)]));
	}
	return value;
}

function defaultSmokeScriptPath() {
	return fileURLToPath(new URL("./smoke-headless-host-sync.mjs", import.meta.url));
}

function defaultSmokeUser(serviceUser, explicitRunuser) {
	if (process.getuid?.() === 0) return serviceUser ?? "kaos";
	if (explicitRunuser && serviceUser) return serviceUser;
	return undefined;
}

function checkNodeVersion(version, minNodeMajor) {
	const match = String(version).trim().match(/^v?(\d+)\./);
	const major = match ? Number.parseInt(match[1], 10) : NaN;
	const ok = Number.isFinite(major) && major >= minNodeMajor;
	return {
		ok,
		minMajor: minNodeMajor,
		actual: String(version).trim(),
		major: Number.isFinite(major) ? major : null,
	};
}

function parsePositiveInt(value, fallback, label) {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`--${label} must be a positive integer`);
	}
	return parsed;
}

function printUsage() {
	console.log(`Usage: node scripts/postflight-headless-host.mjs [options]

Options:
  --binary <path>        Installed headless host binary. Defaults to /opt/kaos/kaos-headless-host.mjs.
  --vault <path>         Primary Oracle/headless vault. Defaults to /srv/kaos/vault.
  --data-file <path>     Primary headless data.json. Defaults to /var/lib/kaos-headless/data.json.
  --lock-file <path>     Primary lock file. Defaults to /run/kaos-headless/kaos.lock.
  --env-file <path>      Environment file. Defaults to /etc/kaos/headless.env.
  --identity-file <path> Protected 0600 device identity. Defaults from KAOS_IDENTITY_FILE.
  --metadata-path <path> Install metadata JSON. Defaults below --binary when present.
  --smoke-script <path>  Smoke script path. Defaults next to this script.
  --smoke-work-dir <path> Retained for compatibility; must be outside the vault when supplied.
  --service <name>       systemd service name. Defaults to kaos-headless-host.
  --service-file <path>  systemd service file used to infer the Node binary.
                         Defaults to /etc/systemd/system/kaos-headless-host.service when present.
  --systemctl <path>     systemctl binary. Defaults to systemctl.
  --smoke-user <user>    Run smoke as this user. Defaults to kaos when postflight runs as root.
  --no-smoke-user        Run smoke as the current user.
  --runuser <path>       User-switch command for --smoke-user. Defaults to runuser.
  --node <path>          Node binary. Overrides --service-file inference.
  --min-node-major <n>   Minimum accepted Node.js major version. Defaults to 20.
  --timeout-ms <ms>      Per-command timeout. Defaults to 120000.
  --skip-service-file-check
                         Do not verify that the systemd service file matches
					 --binary/--vault/--data-file/--lock-file/--env-file and contains no legacy credential flags.
  --skip-metadata-check  Do not verify install metadata sha256/path coherence.
  --skip-service-identity-check
                         Do not verify that service User=/Group= exist.
  --require-service-identity-check
                         Verify service User=/Group= even when not running as root.
  --skip-service-access-check
                         Do not verify service User= access to binary/vault/data/lock/env/identity paths.
  --require-service-access-check
                         Verify service User= access even when not running as root.
  --check-only           Run preflight, metadata/service checks, and doctor without
                         daemon-reload/restart/is-active or sync smoke.
  --verify-running       Verify an already-running service without daemon-reload/restart.
                         Runs preflight, doctor, systemctl is-enabled/is-active, and smoke.
  --skip-systemctl       Run doctor/smoke without daemon-reload/restart/is-active.
  --skip-smoke           Run doctor/systemctl without sync smoke.
  --help, -h             Print this help.
`);
}

main().catch((err) => {
	console.error(JSON.stringify({
		kind: "headless-host-postflight",
		ok: false,
		error: err instanceof Error ? err.message : String(err),
	}));
	process.exitCode = 1;
});
