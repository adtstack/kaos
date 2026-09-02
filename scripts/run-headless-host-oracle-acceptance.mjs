#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PHASE_ORDER = ["preflight", "install", "activate", "reboot", "post-reboot", "update"];
const DEFAULT_ZIP = "dist/kaos-headless-host-oracle.zip";
const DEFAULT_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const CONFIG_ALIASES = new Map([
	["dataFile", "data-file"],
	["deviceName", "device-name"],
	["envFile", "env-file"],
	["evidenceRoot", "evidence-root"],
	["identityFile", "identity-file"],
	["installDir", "install-dir"],
	["installedRunner", "installed-runner"],
	["installedUpdateWrapper", "installed-update-wrapper"],
	["journalSince", "journal-since"],
	["lockFile", "lock-file"],
	["metadataPath", "metadata-path"],
	["postflightSmokeWorkDir", "postflight-smoke-work-dir"],
	["releaseDir", "release-dir"],
	["remoteDir", "remote-dir"],
	["inviteFile", "invite-file"],
	["servicePath", "service-path"],
	["skipLocalPrepare", "skip-local-prepare"],
	["skipPreflight", "skip-preflight"],
	["skipRemotePreflight", "skip-remote-preflight"],
	["skipUpdate", "skip-update"],
	["smokeScript", "smoke-script"],
	["smokeWorkDir", "smoke-work-dir"],
	["sshOption", "ssh-option"],
	["sshOptions", "ssh-option"],
	["sshPort", "ssh-port"],
	["sshTarget", "ssh-target"],
	["startAt", "start-at"],
	["stopAfter", "stop-after"],
	["summaryFile", "summary-file"],
	["deviceIdentityFile", "device-identity-file"],
	["updateRemoteDir", "update-remote-dir"],
	["vaultId", "vault-id"],
	["waitSshConnectTimeoutSec", "wait-ssh-connect-timeout-sec"],
	["waitSshIntervalMs", "wait-ssh-interval-ms"],
	["waitSshTimeoutMs", "wait-ssh-timeout-ms"],
	["workerHost", "worker-host"],
]);
const CONFIG_KEYS = new Set([
	...CONFIG_ALIASES.values(),
	"checksum",
	"node",
	"scp",
	"service",
	"ssh",
	"target",
	"timeout",
	"vault",
	"zip",
]);
const CONFIG_PATH_KEYS = new Set([
	"checksum",
	"evidence-root",
	"identity-file",
	"release-dir",
	"invite-file",
	"summary-file",
	"zip",
]);

async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.help === "true") {
		printUsage();
		return;
	}
	for (const legacy of ["token", "token-file", "secret-file", "token-destination-file"]) {
		if (parsed[legacy] !== undefined) throw new Error(`--${legacy} is no longer supported; use --invite-file for enrollment and an approved service device.`);
	}
	const withConfigDefaults = await applyConfigDefaults(parsed);
	const resumeDefaults = await applyResumeSummaryDefaults(withConfigDefaults);
	const raw = applyReleaseDirDefaults(resumeDefaults.raw);
	const { resumeSummary, resumeSummaryFile } = resumeDefaults;

	const sshTarget = raw["ssh-target"] ?? raw.target;
	if (!sshTarget) throw new Error("--ssh-target is required.");

	const remoteDir = raw["remote-dir"] ?? `kaos-headless-acceptance-${DEFAULT_STAMP}`;
	const updateRemoteDir = raw["update-remote-dir"] ?? `${remoteDir}-update`;
	const evidenceRoot = resolve(raw["evidence-root"] ?? `oracle-acceptance-${DEFAULT_STAMP}`);
	const summaryFile = resolve(raw["summary-file"] ?? join(evidenceRoot, "acceptance-summary.json"));
	const runPhases = selectedPhases(raw);
	const initialCompleted = completedPrefixFromResumeSummary(resumeSummary, runPhases[0]);
	const phases = mergeSummaryPhases(initialCompleted, runPhases);
	validateAcceptanceOptions(raw, runPhases, remoteDir, updateRemoteDir);
	if (runPhases.includes("install") && runPhases.includes("activate")) {
		throw new Error("Initial install and activation must run separately: stop after install, have the Owner approve the displayed fingerprint, then resume at activate.");
	}
	if (runPhases.includes("activate") && raw["confirm-owner-approved"] !== "true" && raw["dry-run"] !== "true" && raw["validate-local"] !== "true") {
		throw new Error("--confirm-owner-approved is required for activation after the Owner has approved the device fingerprint.");
	}
	const requiresConfirmReboot = runPhases.includes("reboot");
	const confirmedReboot = raw["confirm-reboot"] === "true";
	if (requiresConfirmReboot && !confirmedReboot && raw["dry-run"] !== "true" && raw["validate-local"] !== "true") {
		throw new Error("--confirm-reboot is required because acceptance includes the reboot phase.");
	}
	if (runPhases.includes("install")) {
		if (!raw["worker-host"]) throw new Error("--worker-host is required when acceptance includes install.");
		if (!raw["vault-id"]) throw new Error("--vault-id is required when acceptance includes install.");
		if (!raw["invite-file"]) throw new Error("--invite-file is required when acceptance includes install.");
	}

	const evidenceDirs = evidenceDirsFor(phases, evidenceRoot);
	if (raw["validate-local"] === "true") {
		const payload = await validateLocalAcceptance({
			raw,
			sshTarget,
			remoteDir,
			updateRemoteDir,
			evidenceRoot,
			evidenceDirs,
			summaryFile,
			phases,
			runPhases,
			requiresConfirmReboot,
			confirmedReboot,
			resumeSummaryFile,
		});
		if (payload.ok) {
			console.log(JSON.stringify(payload, null, 2));
		} else {
			console.error(JSON.stringify(payload, null, 2));
			process.exitCode = 1;
		}
		return;
	}
	if (raw["dry-run"] === "true") {
		const planned = runPhases.map((phase) => planAcceptancePhase({
			phase,
			raw,
			sshTarget,
			remoteDir: phase === "update" ? updateRemoteDir : remoteDir,
			evidenceRoot,
		}));
		console.log(JSON.stringify({
			kind: "headless-host-oracle-acceptance",
			ok: true,
			dryRun: true,
			sshTarget,
			remoteDir,
			updateRemoteDir,
			evidenceRoot,
			evidenceDirs,
			summaryFile,
			...(raw.config ? { configFile: raw.config } : {}),
			...(raw["release-dir"] ? { releaseDir: raw["release-dir"] } : {}),
			requiresConfirmReboot,
			confirmedReboot,
			phases,
			runPhases,
			planned,
			...(resumeSummaryFile ? { resumedFromSummary: resumeSummaryFile } : {}),
			nextStep: requiresConfirmReboot && !confirmedReboot
				? "review this dry-run output, then rerun without --dry-run and with --confirm-reboot"
				: nextStepAfter(runPhases.at(-1), { remoteDir, updateRemoteDir }),
		}, null, 2));
		return;
	}

	await mkdir(evidenceRoot, { recursive: true });
	const redactor = createRedactor([]);
	const completed = [...initialCompleted];
	const basePayload = {
		kind: "headless-host-oracle-acceptance",
		sshTarget,
		remoteDir,
		updateRemoteDir,
		evidenceRoot,
		evidenceDirs,
		summaryFile,
		...(raw.config ? { configFile: raw.config } : {}),
		...(raw["release-dir"] ? { releaseDir: raw["release-dir"] } : {}),
		dryRun: false,
		requiresConfirmReboot,
		confirmedReboot,
		phases,
		runPhases,
		...(resumeSummaryFile ? { resumedFromSummary: resumeSummaryFile } : {}),
	};

	for (const phase of runPhases) {
		const step = runAcceptancePhase({
			phase,
			raw,
			sshTarget,
			remoteDir: phase === "update" ? updateRemoteDir : remoteDir,
			evidenceRoot,
			redactor,
		});
		completed.push(step);
		if (step.status !== 0) {
			const lastSuccessfulPhase = completed.filter((item) => item.status === 0).at(-1)?.phase ?? null;
			const failedPayload = {
				...basePayload,
				ok: false,
				inProgress: false,
				failedPhase: phase,
				lastSuccessfulPhase,
				completed,
				nextStep: lastSuccessfulPhase
					? nextStepAfter(lastSuccessfulPhase, { remoteDir, updateRemoteDir })
					: `rerun with --start-at ${phase} --remote-dir ${phase === "update" ? updateRemoteDir : remoteDir}`,
			};
			await writeSummaryFile(summaryFile, failedPayload);
			console.error(JSON.stringify(failedPayload, null, 2));
			process.exit(1);
		}

		const progressPayload = {
			...basePayload,
			ok: false,
			inProgress: true,
			lastSuccessfulPhase: phase,
			completed,
			nextStep: nextStepAfter(phase, { remoteDir, updateRemoteDir }),
		};
		await writeSummaryFile(summaryFile, progressPayload);
	}

	const successPayload = {
		...basePayload,
		ok: true,
		inProgress: false,
		lastSuccessfulPhase: completed.at(-1)?.phase ?? null,
		completed,
		nextStep: nextStepAfter(phases.at(-1), { remoteDir, updateRemoteDir }),
	};
	await writeSummaryFile(summaryFile, successPayload);
	console.log(JSON.stringify(successPayload, null, 2));
}

function validateAcceptanceOptions(raw, phases, remoteDir, updateRemoteDir) {
	if (raw["skip-local-prepare"] === "true" && phases.some((phase) => phase === "install" || phase === "update") && (!raw.zip || !raw.checksum)) {
		throw new Error("--skip-local-prepare requires explicit --zip and --checksum when acceptance includes install or update.");
	}
	if (raw["skip-local-prepare"] !== "true" && phases.some((phase) => phase === "install" || phase === "update") && !findLocalHelper("prepare-headless-host-oracle-upload.mjs")) {
		throw new Error("acceptance install/update requires prepare-headless-host-oracle-upload.mjs unless --skip-local-prepare is used with explicit --zip and --checksum release assets.");
	}
	if (phases.includes("update") && updateRemoteDir === remoteDir) {
		throw new Error("--update-remote-dir must differ from --remote-dir when acceptance includes update, so update evidence does not overwrite install/reboot evidence.");
	}
}

async function applyConfigDefaults(raw) {
	if (!raw.config) return raw;

	const configFile = resolve(raw.config);
	const configDir = dirname(configFile);
	const config = JSON.parse(await readFile(configFile, "utf8"));
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error(`--config must point to a JSON object: ${configFile}`);
	}

	const out = { ...raw, config: configFile };
	for (const [inputKey, rawValue] of Object.entries(config)) {
		const key = CONFIG_ALIASES.get(inputKey) ?? inputKey;
		if (!CONFIG_KEYS.has(key)) {
			throw new Error(`unsupported acceptance config key "${inputKey}" in ${configFile}`);
		}
		if (out[key] !== undefined) continue;
		out[key] = normalizeConfigValue({ key, value: rawValue, configDir, configFile });
	}
	return out;
}

function normalizeConfigValue({ key, value, configDir, configFile }) {
	if (Array.isArray(value)) {
		if (key !== "ssh-option") {
			throw new Error(`acceptance config key "${key}" must not be an array in ${configFile}`);
		}
		return value.map((item) => normalizeScalarConfigValue({ key, value: item, configDir, configFile }));
	}
	return normalizeScalarConfigValue({ key, value, configDir, configFile });
}

function normalizeScalarConfigValue({ key, value, configDir, configFile }) {
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value !== "string") {
		throw new Error(`acceptance config key "${key}" must be a string, number, boolean, or ssh-option array in ${configFile}`);
	}
	if (CONFIG_PATH_KEYS.has(key) && value.length > 0) {
		return resolve(configDir, value);
	}
	return value;
}

function applyReleaseDirDefaults(raw) {
	if (!raw["release-dir"]) return raw;

	const releaseDir = resolve(raw["release-dir"]);
	const out = { ...raw, "release-dir": releaseDir };
	defaultArg(out, "zip", join(releaseDir, "kaos-headless-host-oracle.zip"));
	defaultArg(out, "checksum", join(releaseDir, "kaos-headless-host-oracle.zip.sha256"));
	out["skip-local-prepare"] = "true";
	return out;
}

async function validateLocalAcceptance({
	raw,
	sshTarget,
	remoteDir,
	updateRemoteDir,
	evidenceRoot,
	evidenceDirs,
	summaryFile,
	phases,
	runPhases,
	requiresConfirmReboot,
	confirmedReboot,
	resumeSummaryFile,
}) {
	const checks = [];
	const needsInstallOrUpdate = runPhases.some((phase) => phase === "install" || phase === "update");
	const needsInstall = runPhases.includes("install");
	const needsEvidenceVerifier = runPhases.some((phase) => phase === "install" || phase === "post-reboot" || phase === "update");
	addPlaceholderChecks(checks, {
		"ssh-target": sshTarget,
		"remote-dir": remoteDir,
		"update-remote-dir": updateRemoteDir,
		...(raw["worker-host"] ? { "worker-host": raw["worker-host"] } : {}),
		...(raw["vault-id"] ? { "vault-id": raw["vault-id"] } : {}),
		...(raw["invite-file"] ? { "invite-file": raw["invite-file"] } : {}),
	});
	addCheck(checks, "helper:remote-rehearsal", Boolean(findLocalHelper("run-headless-host-oracle-remote-rehearsal.mjs")), {
		helper: "run-headless-host-oracle-remote-rehearsal.mjs",
		error: "acceptance wrapper must be run from the repo root or a release directory containing the remote rehearsal helper",
	});
	if (needsEvidenceVerifier) {
		addCheck(checks, "helper:oracle-rehearsal-verifier", Boolean(findLocalHelper("verify-headless-host-oracle-rehearsal.mjs")), {
			helper: "verify-headless-host-oracle-rehearsal.mjs",
			error: "install, post-reboot, and update phases fetch evidence that must be verified by the Oracle rehearsal verifier helper",
		});
	}
	if (needsInstall) {
		await addPrivateFileCheck(checks, "invite-file", resolve(raw["invite-file"]));
	}
	if (needsInstallOrUpdate) {
		if (raw["skip-local-prepare"] === "true") {
			await addReleaseAssetChecks(checks, {
				zipPath: resolve(raw.zip),
				checksumPath: resolve(raw.checksum),
			});
		} else {
			await addLocalUploadPrepareCheck(checks, raw);
		}
	}

	const failedChecks = checks.filter((check) => !check.ok);
	return {
		kind: "headless-host-oracle-acceptance-local-validate",
		ok: failedChecks.length === 0,
		sshTarget,
		remoteDir,
		updateRemoteDir,
		evidenceRoot,
		evidenceDirs,
		summaryFile,
		...(raw.config ? { configFile: raw.config } : {}),
		...(raw["release-dir"] ? { releaseDir: raw["release-dir"] } : {}),
		...(resumeSummaryFile ? { resumedFromSummary: resumeSummaryFile } : {}),
		requiresConfirmReboot,
		confirmedReboot,
		phases,
		runPhases,
		checks,
		failedChecks,
		nextStep: failedChecks.length === 0
			? "local validation passed; rerun with --dry-run, then rerun with --confirm-reboot when ready"
			: "fix failed local checks before running --dry-run or touching the Oracle VM",
	};
}

function addPlaceholderChecks(checks, values) {
	for (const [field, value] of Object.entries(values)) {
		if (typeof value !== "string") continue;
		const placeholder = detectPlaceholder(value);
		addCheck(checks, `value:${field}:not-placeholder`, !placeholder, {
			field,
			value,
			placeholder,
			error: `${field} still looks like an example placeholder`,
		});
	}
}

function detectPlaceholder(value) {
	const upper = value.toUpperCase();
	if (upper.includes("YOUR_")) return "YOUR_*";
	if (upper.includes("YYYYMMDD")) return "YYYYMMDD*";
	if (value.includes("/secure/local/path")) return "/secure/local/path";
	if (value.includes("<") || value.includes(">")) return "angle-bracket placeholder";
	return null;
}

async function addPrivateFileCheck(checks, name, path) {
	try {
		const details = await lstat(path);
		const ok = details.isFile() && !details.isSymbolicLink() && (details.mode & 0o077) === 0;
		addCheck(checks, `file:${name}`, ok, {
			path,
			mode: `0${(details.mode & 0o777).toString(8).padStart(3, "0")}`,
			error: `${name} must be a regular 0600 file`,
		});
	} catch (err) {
		addCheck(checks, `file:${name}`, false, { path, error: err instanceof Error ? err.message : String(err) });
	}
}

async function addReleaseAssetChecks(checks, { zipPath, checksumPath }) {
	const validator = findLocalHelper("validate-headless-host-release-assets.mjs");
	if (!validator) {
		addCheck(checks, "release-assets-validate", false, {
			zipPath,
			checksumPath,
			error: "validate-headless-host-release-assets.mjs is required to validate release assets locally",
		});
		return;
	}
	const result = spawnSync(process.execPath, [
		validator,
		"--zip",
		zipPath,
		"--checksum",
		checksumPath,
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	const payload = parseJsonOutput(result.stdout ?? "") ?? parseJsonOutput(result.stderr ?? "");
	if (Array.isArray(payload?.checks)) {
		checks.push(...payload.checks);
	}
	addCheck(checks, "release-assets-validate", result.status === 0 && payload?.ok === true, {
		command: process.execPath,
		args: [validator, "--zip", zipPath, "--checksum", checksumPath],
		status: result.status,
		signal: result.signal,
		payload: summarizeReleaseAssetsValidation(payload),
		stdout: payload ? undefined : trimOutput(result.stdout ?? ""),
		stderr: payload ? undefined : trimOutput(result.stderr ?? ""),
		error: "release assets must pass local validation before Oracle acceptance",
	});
}

function summarizeReleaseAssetsValidation(payload) {
	if (!payload || typeof payload !== "object") return payload;
	return {
		kind: payload.kind ?? null,
		ok: payload.ok === true,
		zipPath: payload.zipPath ?? null,
		checksumPath: payload.checksumPath ?? null,
		checkCount: Array.isArray(payload.checks) ? payload.checks.length : null,
		failedCheckCount: Array.isArray(payload.failedChecks) ? payload.failedChecks.length : null,
	};
}

async function addLocalUploadPrepareCheck(checks, raw) {
	const prepare = findLocalHelper("prepare-headless-host-oracle-upload.mjs");
	if (!prepare) {
		addCheck(checks, "local-upload-prepare:helper", false, {
			helper: "prepare-headless-host-oracle-upload.mjs",
			error: "local upload prepare helper is required unless release assets are used with --release-dir or --skip-local-prepare",
		});
		return;
	}
	const zipPath = resolve(raw.zip ?? DEFAULT_ZIP);
	const checksumPath = resolve(raw.checksum ?? `${zipPath}.sha256`);
	const result = spawnSync(process.execPath, [
		prepare,
		"--zip",
		zipPath,
		"--checksum",
		checksumPath,
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	const payload = parseJsonOutput(result.stdout ?? "") ?? parseJsonOutput(result.stderr ?? "");
	addCheck(checks, "local-upload-prepare", result.status === 0 && payload?.ok === true, {
		command: process.execPath,
		args: redactArgs([prepare, "--zip", zipPath, "--checksum", checksumPath]),
		status: result.status,
		signal: result.signal,
		payload,
		stdout: payload ? undefined : trimOutput(result.stdout ?? ""),
		stderr: payload ? undefined : trimOutput(result.stderr ?? ""),
		error: "local upload prepare must pass before Oracle acceptance",
	});
}

function addCheck(checks, name, ok, detail = {}) {
	const check = { name, ok: Boolean(ok), ...detail };
	if (check.ok) delete check.error;
	checks.push(check);
}

async function applyResumeSummaryDefaults(raw) {
	if (!raw["resume-from-summary"]) return { raw, resumeSummary: null, resumeSummaryFile: null };

	const out = { ...raw };
	const resumeSummaryFile = resolve(out["resume-from-summary"]);
	const resumeSummary = JSON.parse(await readFile(resumeSummaryFile, "utf8"));
	validateResumeSummary(resumeSummary, resumeSummaryFile);

	if (out["ssh-target"] === undefined && out.target === undefined) {
		defaultArg(out, "ssh-target", resumeSummary.sshTarget);
	}
	defaultArg(out, "remote-dir", resumeSummary.remoteDir);
	defaultArg(out, "update-remote-dir", resumeSummary.updateRemoteDir);
	defaultArg(out, "evidence-root", resumeSummary.evidenceRoot ?? dirname(resumeSummaryFile));
	defaultArg(out, "summary-file", resumeSummaryFile);
	defaultArg(out, "release-dir", resumeSummary.releaseDir);
	if (out["start-at"] === undefined) {
		const startAt = resumeStartAt(resumeSummary);
		if (!startAt) {
			throw new Error("--resume-from-summary points to an acceptance summary that has already completed every phase; pass --start-at explicitly to rerun a phase.");
		}
		out["start-at"] = startAt;
	}

	return { raw: out, resumeSummary, resumeSummaryFile };
}

function validateResumeSummary(summary, summaryFile) {
	if (summary?.kind !== "headless-host-oracle-acceptance" || summary.dryRun !== false) {
		throw new Error(`--resume-from-summary must point to a non-dry-run acceptance summary: ${summaryFile}`);
	}
	for (const [name, value] of [
		["sshTarget", summary.sshTarget],
		["remoteDir", summary.remoteDir],
		["updateRemoteDir", summary.updateRemoteDir],
	]) {
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`--resume-from-summary summary is missing ${name}: ${summaryFile}`);
		}
	}
	if (summary.releaseDir !== undefined && (typeof summary.releaseDir !== "string" || summary.releaseDir.length === 0)) {
		throw new Error(`--resume-from-summary summary has an invalid releaseDir: ${summaryFile}`);
	}
	if (!Array.isArray(summary.completed)) {
		throw new Error(`--resume-from-summary summary is missing completed phase results: ${summaryFile}`);
	}
}

function resumeStartAt(summary) {
	if (PHASE_ORDER.includes(summary.failedPhase)) return summary.failedPhase;
	const lastSuccessfulPhase = summary.lastSuccessfulPhase ?? summary.completed.filter((step) => step?.status === 0 && step?.payload?.ok === true).at(-1)?.phase;
	if (!lastSuccessfulPhase) return PHASE_ORDER[0];
	const index = PHASE_ORDER.indexOf(lastSuccessfulPhase);
	if (index < 0) {
		throw new Error(`cannot infer resume phase from unknown lastSuccessfulPhase: ${lastSuccessfulPhase}`);
	}
	return PHASE_ORDER[index + 1] ?? null;
}

function completedPrefixFromResumeSummary(summary, firstRunPhase) {
	if (!summary) return [];
	const firstRunIndex = PHASE_ORDER.indexOf(firstRunPhase);
	if (firstRunIndex < 0) return [];
	return summary.completed
		.filter((step) => step?.status === 0 && step?.payload?.ok === true)
		.filter((step) => PHASE_ORDER.indexOf(step.phase) >= 0 && PHASE_ORDER.indexOf(step.phase) < firstRunIndex)
		.sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase));
}

function mergeSummaryPhases(initialCompleted, runPhases) {
	const phases = [
		...initialCompleted.map((step) => step.phase),
		...runPhases,
	];
	const uniquePhases = [...new Set(phases)];
	if (uniquePhases.length !== phases.length) {
		throw new Error(`resume summary and requested run phases overlap: ${phases.join(", ")}`);
	}
	if (!isContiguousPhaseSlice(uniquePhases)) {
		throw new Error(`resume summary and requested run phases must form a contiguous phase slice: ${uniquePhases.join(", ")}`);
	}
	return uniquePhases;
}

function isContiguousPhaseSlice(phases) {
	if (!Array.isArray(phases) || phases.length === 0) return false;
	const indices = phases.map((phase) => PHASE_ORDER.indexOf(phase));
	if (indices.some((index) => index < 0)) return false;
	for (let i = 1; i < indices.length; i++) {
		if (indices[i] !== indices[i - 1] + 1) return false;
	}
	return true;
}

function defaultArg(raw, name, value) {
	if (raw[name] === undefined && value !== undefined && value !== null) {
		raw[name] = value;
	}
}

function evidenceDirsFor(phases, evidenceRoot) {
	return Object.fromEntries(
		["install", "post-reboot", "update"]
			.filter((phase) => phases.includes(phase))
			.map((phase) => [phase, join(evidenceRoot, phase)]),
	);
}

function nextStepAfter(lastPhase, { remoteDir, updateRemoteDir }) {
	if (lastPhase === "preflight") return `rerun with --start-at install --remote-dir ${remoteDir}`;
	if (lastPhase === "install") return `Compare and approve the pending device fingerprint, then rerun with --start-at activate --confirm-owner-approved --remote-dir ${remoteDir}`;
	if (lastPhase === "activate") return `rerun with --start-at reboot --remote-dir ${remoteDir} --confirm-reboot`;
	if (lastPhase === "reboot") return `rerun with --start-at post-reboot --remote-dir ${remoteDir}`;
	if (lastPhase === "post-reboot") return `rerun with --start-at update --remote-dir ${remoteDir} --update-remote-dir ${updateRemoteDir}`;
	return "acceptance complete; inspect evidenceRoot and keep the update evidence with the release";
}

async function writeSummaryFile(path, payload) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function selectedPhases(raw) {
	const base = raw["skip-preflight"] === "true"
		? PHASE_ORDER.filter((phase) => phase !== "preflight")
		: [...PHASE_ORDER];
	const order = raw["skip-update"] === "true"
		? base.filter((phase) => phase !== "update")
		: base;
	const startAt = raw["start-at"] ?? order[0];
	const stopAfter = raw["stop-after"] ?? order.at(-1);
	const start = order.indexOf(startAt);
	const stop = order.indexOf(stopAfter);
	if (start < 0) throw new Error(`--start-at must be one of: ${order.join(", ")}`);
	if (stop < 0) throw new Error(`--stop-after must be one of: ${order.join(", ")}`);
	if (stop < start) throw new Error("--stop-after must not come before --start-at.");
	return order.slice(start, stop + 1);
}

function planAcceptancePhase({ phase, raw, sshTarget, remoteDir, evidenceRoot }) {
	const args = buildAcceptancePhaseArgs({ phase, raw, sshTarget, remoteDir, evidenceRoot });
	return {
		phase,
		command: process.execPath,
		args: redactArgs(args),
		remoteDir,
		...(evidenceDirForPhase(phase, evidenceRoot) ? { evidenceDir: evidenceDirForPhase(phase, evidenceRoot) } : {}),
	};
}

function runAcceptancePhase({ phase, raw, sshTarget, remoteDir, evidenceRoot, redactor }) {
	const args = buildAcceptancePhaseArgs({ phase, raw, sshTarget, remoteDir, evidenceRoot });
	const result = spawnSync(process.execPath, args, { encoding: "utf8" });
	const stdout = redactor(result.stdout ?? "");
	const stderr = redactor(result.stderr ?? "");
	return {
		phase,
		command: process.execPath,
		args: redactArgs(args),
		status: result.status,
		signal: result.signal,
		stdout: trimOutput(stdout),
		stderr: trimOutput(stderr),
		payload: parseJsonOutput(stdout) ?? parseJsonOutput(stderr),
	};
}

function buildAcceptancePhaseArgs({ phase, raw, sshTarget, remoteDir, evidenceRoot }) {
	const helper = resolveLocalHelper("run-headless-host-oracle-remote-rehearsal.mjs");
	const args = [
		helper,
		"--phase",
		phase,
		"--ssh-target",
		sshTarget,
		"--remote-dir",
		remoteDir,
		...commonForwardedArgs(raw),
	];

	if (phase === "install") {
		args.push(
			"--worker-host",
			raw["worker-host"],
			"--vault-id",
			raw["vault-id"],
			"--invite-file",
			resolve(raw["invite-file"]),
			"--evidence-dir",
			join(evidenceRoot, "install"),
		);
		pushOptional(args, raw, ["device-name", "device-identity-file"]);
		pushInstallUpdateOptions(args, raw);
		pushLocalPrepareOptions(args, raw);
	} else if (phase === "activate") {
		args.push("--confirm-owner-approved");
		pushOptional(args, raw, ["install-dir", "installed-runner", "service-path", "postflight-smoke-work-dir", "device-identity-file"]);
	} else if (phase === "update") {
		args.push("--evidence-dir", join(evidenceRoot, "update"));
		pushInstallUpdateOptions(args, raw);
		pushLocalPrepareOptions(args, raw);
	} else if (phase === "post-reboot") {
		args.push(
			"--wait-for-ssh",
			"--require-reboot-request",
			"--evidence-dir",
			join(evidenceRoot, "post-reboot"),
		);
		pushOptional(args, raw, [
			"wait-ssh-timeout-ms",
			"wait-ssh-interval-ms",
			"wait-ssh-connect-timeout-sec",
			"install-dir",
			"installed-runner",
			"service-path",
			"installed-update-wrapper",
			"smoke-script",
			"service",
			"journal-since",
			"postflight-smoke-work-dir",
			"vault",
			"data-file",
			"lock-file",
			"env-file",
			"device-identity-file",
			"smoke-work-dir",
		]);
	}

	return args;
}

function evidenceDirForPhase(phase, evidenceRoot) {
	if (phase === "install" || phase === "post-reboot" || phase === "update") return join(evidenceRoot, phase);
	return null;
}

function commonForwardedArgs(raw) {
	const args = [];
	pushOptional(args, raw, ["ssh", "scp", "identity-file", "ssh-port", "timeout", "zip", "checksum"]);
	for (const option of asArray(raw["ssh-option"])) {
		args.push("--ssh-option", option);
	}
	return args;
}

function pushInstallUpdateOptions(args, raw) {
	pushOptional(args, raw, [
		"install-dir",
		"service-path",
		"metadata-path",
		"postflight-smoke-work-dir",
		"node",
		"device-identity-file",
	]);
	if (raw["skip-remote-preflight"] === "true") args.push("--skip-remote-preflight");
}

function pushLocalPrepareOptions(args, raw) {
	if (raw["skip-local-prepare"] === "true") args.push("--skip-local-prepare");
}

function pushOptional(args, raw, names) {
	for (const name of names) {
		if (raw[name] === undefined) continue;
		args.push(`--${name}`, raw[name]);
	}
}


function resolveLocalHelper(name) {
	const found = findLocalHelper(name);
	if (found) return found;
	throw new Error(`required local helper not found: ${name}. Run from the repo root or from a release asset directory containing the Oracle helpers.`);
}

function findLocalHelper(name) {
	for (const candidate of [
		join("scripts", name),
		name,
		join(SCRIPT_DIR, name),
		join(SCRIPT_DIR, "scripts", name),
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = "true";
			continue;
		}
		if ([
			"--confirm-reboot",
			"--confirm-owner-approved",
			"--skip-preflight",
			"--skip-update",
			"--skip-local-prepare",
			"--skip-remote-preflight",
			"--dry-run",
			"--validate-local",
		].includes(arg)) {
			out[arg.slice(2)] = "true";
			continue;
		}
		if (!arg.startsWith("--")) {
			throw new Error(`unexpected positional argument: ${arg}`);
		}
		const withoutPrefix = arg.slice(2);
		const eq = withoutPrefix.indexOf("=");
		if (eq >= 0) {
			setArg(out, withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1));
			continue;
		}
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			throw new Error(`missing value for --${withoutPrefix}`);
		}
		setArg(out, withoutPrefix, next);
		i++;
	}
	return out;
}

function setArg(out, name, value) {
	if (name === "ssh-option") {
		out[name] = [...asArray(out[name]), value];
		return;
	}
	out[name] = value;
}

function asArray(value) {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

function createRedactor(secrets) {
	const needles = secrets
		.flatMap((secret) => typeof secret === "string" ? [secret, secret.trim()] : [])
		.filter((secret) => secret.length >= 3);
	return (text) => {
		let out = text;
		for (const secret of needles) {
			out = out.split(secret).join("[redacted]");
		}
		return out;
	};
}

function redactArgs(args) {
	const redacted = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--invite-file") {
			redacted.push(arg, "[invite-file]");
			i++;
			continue;
		}
		redacted.push(String(arg));
	}
	return redacted;
}

function parseJsonOutput(text) {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

function trimOutput(text) {
	const trimmed = text.trim();
	return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}...` : trimmed;
}

function printUsage() {
	console.log(`Usage: node scripts/run-headless-host-oracle-acceptance.mjs [options]

Runs the full real-VM Oracle acceptance flow by delegating to
run-headless-host-oracle-remote-rehearsal.mjs for each phase:
preflight -> install -> activate -> reboot -> post-reboot -> update.

Required for a full run:
  --ssh-target <user@host>
  --worker-host <url>
  --vault-id <id>
  --invite-file <path>
  --confirm-reboot

Common options:
  --remote-dir <path>          Remote install/reboot/post-reboot evidence dir.
  --update-remote-dir <path>   Remote update evidence dir. Defaults to <remote-dir>-update
                               and must differ from --remote-dir.
  --evidence-root <path>       Local evidence root. Defaults to oracle-acceptance-<timestamp>.
  --summary-file <path>        Acceptance result summary JSON. Defaults to
                               <evidence-root>/acceptance-summary.json.
  --config <path>              JSON defaults for this command. CLI flags override
                               config values. Relative file paths in config are
                               resolved from the config file directory.
  --validate-local             Validate config, protected invitation file, release assets, and
                               local bundle gates without running ssh/scp,
                               writing evidence, or requiring --confirm-reboot.
  --dry-run                    Print the exact phase plan without running ssh/scp,
                               creating evidence directories, or requiring --confirm-reboot.
  --resume-from-summary <path> Resume from a previous acceptance summary. Defaults
                               ssh target, remote dirs, evidence root, summary file,
                               and start phase from the saved result, then merges
                               earlier successful phases into the new summary.
  --start-at <phase>           Resume at preflight, install, activate, reboot, post-reboot, or update.
  --stop-after <phase>         Stop after a specific phase.
  --skip-preflight             Omit the standalone preflight phase.
  --skip-update                Omit the final update rehearsal.
  --identity-file <path>       Forwarded to ssh/scp.
  --ssh-port <port>            Forwarded to ssh/scp.
  --ssh-option <name=value>    Forwarded to ssh/scp. May be repeated.
  --release-dir <path>         Directory containing release assets. Defaults
                               --skip-local-prepare, --zip, and --checksum to
                               <path>/kaos-headless-host-oracle.zip(.sha256).
  --zip <path>                 Oracle bundle zip.
  --checksum <path>            Oracle bundle checksum.
  --skip-local-prepare         Use explicit trusted --zip/--checksum release assets.
                               Requires both --zip and --checksum when install/update run.
  --skip-remote-preflight      Skip install/update preflight; standalone preflight is unaffected.
  --install-dir <path>         Forwarded install directory.
  --service-path <path>        Forwarded systemd service path.
  --metadata-path <path>       Forwarded install metadata path.
  --service <name>             Forwarded post-reboot service name.
  --journal-since <value>      Forwarded journalctl --since value.
  --smoke-work-dir <path>      Forwarded standalone smoke work directory.
  --wait-ssh-timeout-ms <ms>   Forwarded post-reboot SSH wait timeout.
  --device-identity-file <path> Remote service identity location. Defaults to the protected system path.
  --ssh <path>                 SSH executable. Defaults to ssh.
  --scp <path>                 SCP executable. Defaults to scp.
  --timeout <ms>               Remote phase command timeout.

Example:
  npm run run:headless-host-oracle-acceptance -- \\
    --ssh-target opc@YOUR_ORACLE_VM \\
    --worker-host https://YOUR_WORKER_HOST \\
    --vault-id YOUR_VAULT_ID \\
		--invite-file /secure/local/path/to/device-enroll.invite \\
    --remote-dir kaos-headless-acceptance-YYYYMMDDTHHMMSSZ \\
    --evidence-root ./oracle-acceptance-logs \\
    --confirm-reboot
`);
}

main().catch((err) => {
	console.error(JSON.stringify({
		kind: "headless-host-oracle-acceptance",
		ok: false,
		failedPhase: "fatal",
		error: err instanceof Error ? err.message : String(err),
	}, null, 2));
	process.exitCode = 1;
});
