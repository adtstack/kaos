#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FULL_PHASES = ["preflight", "install", "reboot", "post-reboot", "update"];

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}

	const evidenceRoot = raw["evidence-root"] ? resolve(raw["evidence-root"]) : null;
	const summaryFile = resolve(raw["summary-file"] ?? join(evidenceRoot ?? ".", "acceptance-summary.json"));
	const summaryText = await readFile(summaryFile, "utf8");
	const summary = JSON.parse(summaryText);
	const secretFile = raw["secret-file"] ? resolve(raw["secret-file"]) : null;
	const secret = secretFile ? await readFile(secretFile, "utf8").catch(() => "") : "";
	const redactor = createRedactor([secret]);
	const requireFull = raw["require-full"] === "true";
	const checks = [];
	const verifications = [];
	const phases = Array.isArray(summary.phases) ? summary.phases : [];
	const completed = Array.isArray(summary.completed) ? summary.completed : [];
	const root = evidenceRoot ?? dirname(summaryFile);
	const evidencePhases = ["install", "post-reboot", "update"].filter((phase) => phases.includes(phase));
	const phaseEvidenceDirs = Object.fromEntries(
		evidencePhases.map((phase) => [phase, resolvePhaseEvidenceDir({ phase, root, summary })]),
	);
	const summarySecretLeakCheck = checkSummarySecretLeak(summaryText, secret, summaryFile, checks);

	addCheck(checks, "summary:shape", summary.kind === "headless-host-oracle-acceptance" && summary.dryRun === false, {
		kind: summary.kind ?? null,
		dryRun: summary.dryRun ?? null,
		error: "summary must be a non-dry-run acceptance result",
	});
	addCheck(checks, "summary:ok", summary.ok === true, {
		ok: summary.ok ?? null,
		failedPhase: summary.failedPhase ?? null,
		error: "acceptance summary must be successful",
	});
	addCheck(checks, "summary:not-in-progress", summary.inProgress !== true, {
		inProgress: summary.inProgress ?? null,
		error: "acceptance summary must be a finalized result, not an in-progress checkpoint",
	});
	addCheck(checks, "summary:completed", Array.isArray(summary.completed) && phases.every((phase) => summary.completed.some((step) => step?.phase === phase && step?.status === 0 && step?.payload?.ok === true)), {
		phaseCount: phases.length,
		completedCount: completed.length,
		error: "every summary phase must have a successful completed step",
	});
	addCheck(checks, "summary:completed-order", completed.length === phases.length && completed.every((step, index) => step?.phase === phases[index]), {
		phases,
		completedPhases: completed.map((step) => step?.phase ?? null),
		error: "completed phase results must match the summary phase order exactly",
	});
	addCheck(checks, "summary:completed-payload-phase", completed.length === phases.length && completed.every((step, index) => (
		step?.status === 0
			&& step?.signal === null
			&& step?.payload?.kind === "headless-host-oracle-remote-rehearsal"
			&& step?.payload?.ok === true
			&& step?.payload?.phase === phases[index]
	)), {
		expectedPhases: phases,
		payloadPhases: completed.map((step) => step?.payload?.phase ?? null),
		error: "each completed step payload must be a successful remote rehearsal for the same phase",
	});
	addCheck(checks, "summary:phases", phases.every((phase) => FULL_PHASES.includes(phase)), {
		phases,
		error: "summary phases must be known acceptance phases",
	});
	addCheck(checks, "summary:phase-unique", new Set(phases).size === phases.length, {
		phases,
		error: "summary phases must not contain duplicates",
	});
	addCheck(checks, "summary:phase-contiguous", isContiguousPhaseSlice(phases), {
		phases,
		requiredOrder: FULL_PHASES,
		error: "summary phases must be a contiguous slice of the acceptance order",
	});
	addCheck(checks, "summary:last-successful-phase", summary.lastSuccessfulPhase === phases.at(-1), {
		lastSuccessfulPhase: summary.lastSuccessfulPhase ?? null,
		expected: phases.at(-1) ?? null,
		error: "successful acceptance summary must report the last phase as lastSuccessfulPhase",
	});
	addCheck(checks, "summary:remote-dirs", typeof summary.remoteDir === "string" && summary.remoteDir.length > 0 && typeof summary.updateRemoteDir === "string" && summary.updateRemoteDir.length > 0, {
		remoteDir: summary.remoteDir ?? null,
		updateRemoteDir: summary.updateRemoteDir ?? null,
		error: "summary must record both remoteDir and updateRemoteDir",
	});
	addCheck(checks, "summary:remote-dirs-distinct", !phases.includes("update") || (typeof summary.remoteDir === "string" && typeof summary.updateRemoteDir === "string" && summary.remoteDir !== summary.updateRemoteDir), {
		remoteDir: summary.remoteDir ?? null,
		updateRemoteDir: summary.updateRemoteDir ?? null,
		error: "update phase evidence must use an updateRemoteDir that differs from remoteDir",
	});
	addCheck(checks, "summary:completed-payload-targets", completed.length === phases.length && completed.every((step, index) => (
		step?.payload?.sshTarget === summary.sshTarget
			&& step?.payload?.remoteDir === expectedRemoteDirForPhase(phases[index], summary)
	)), {
		sshTarget: summary.sshTarget ?? null,
		remoteDir: summary.remoteDir ?? null,
		updateRemoteDir: summary.updateRemoteDir ?? null,
		payloadTargets: completed.map((step) => ({
			phase: step?.phase ?? null,
			sshTarget: step?.payload?.sshTarget ?? null,
			remoteDir: step?.payload?.remoteDir ?? null,
		})),
		error: "each completed payload must point at the summary sshTarget and the expected phase remote directory",
	});
	for (const phase of evidencePhases) {
		const recorded = summary.evidenceDirs?.[phase];
		addCheck(checks, `summary:evidence-dir:${phase}`, typeof recorded === "string" && recorded.length > 0, {
			phase,
			recorded: recorded ?? null,
			error: `summary must record an evidence directory for ${phase}`,
		});
	}
	const recordedEvidenceDirs = evidencePhases.map((phase) => summary.evidenceDirs?.[phase]);
	const resolvedRecordedEvidenceDirs = recordedEvidenceDirs
		.filter((dir) => typeof dir === "string" && dir.length > 0)
		.map((dir) => resolve(dir));
	addCheck(checks, "summary:evidence-dirs-distinct", resolvedRecordedEvidenceDirs.length === evidencePhases.length && new Set(resolvedRecordedEvidenceDirs).size === resolvedRecordedEvidenceDirs.length, {
		phases: evidencePhases,
		evidenceDirs: Object.fromEntries(evidencePhases.map((phase) => [phase, summary.evidenceDirs?.[phase] ?? null])),
		error: "install, post-reboot, and update evidence directories must be recorded separately",
	});
	if (requireFull) {
		addCheck(checks, "summary:full-phases", phases.length === FULL_PHASES.length && FULL_PHASES.every((phase, index) => phases[index] === phase), {
			phases,
			requiredPhases: FULL_PHASES,
			error: "full acceptance must exactly match the full phase order",
		});
	}

	for (const phase of evidencePhases) {
		const logDir = phaseEvidenceDirs[phase];
		const result = runPhaseVerifier({ phase, logDir, secretFile, redactor });
		verifications.push(result);
		addCheck(checks, `phase:${phase}:evidence`, result.ok, {
			phase,
			logDir,
			status: result.status,
			error: result.ok ? undefined : "phase evidence verifier failed",
		});
	}

	const failedChecks = checks.filter((check) => !check.ok);
	const payload = {
		kind: "headless-host-oracle-acceptance-verify",
		ok: failedChecks.length === 0,
		summaryFile,
		evidenceRoot: root,
		requireFull,
		phases,
		checks,
		summarySecretLeakCheck,
		verifications,
		failedChecks,
	};
	if (payload.ok) {
		console.log(JSON.stringify(payload, null, 2));
	} else {
		console.error(JSON.stringify(payload, null, 2));
		process.exitCode = 1;
	}
}

function resolvePhaseEvidenceDir({ phase, root, summary }) {
	const portable = join(root, phase);
	if (existsSync(portable)) return portable;
	const recorded = summary.evidenceDirs?.[phase];
	return recorded ? resolve(recorded) : portable;
}

function expectedRemoteDirForPhase(phase, summary) {
	return phase === "update" ? summary.updateRemoteDir : summary.remoteDir;
}

function isContiguousPhaseSlice(phases) {
	if (!Array.isArray(phases) || phases.length === 0) return false;
	const indices = phases.map((phase) => FULL_PHASES.indexOf(phase));
	if (indices.some((index) => index < 0)) return false;
	if (new Set(indices).size !== indices.length) return false;
	for (let i = 1; i < indices.length; i++) {
		if (indices[i] !== indices[i - 1] + 1) return false;
	}
	return true;
}

function runPhaseVerifier({ phase, logDir, secretFile, redactor }) {
	const verifier = resolveLocalHelper("verify-headless-host-oracle-rehearsal.mjs");
	const args = [
		verifier,
		"--log-dir",
		logDir,
	];
	if (phase === "install") {
		args.push("--mode", "install");
	} else if (phase === "update") {
		args.push("--mode", "update");
	} else {
		args.push("--require-reboot-request");
	}
	if (secretFile) {
		args.push("--secret-file", secretFile);
	}
	const result = spawnSync(process.execPath, args, {
		encoding: "utf8",
		timeout: 120_000,
	});
	const stdout = redactor(result.stdout ?? "");
	const stderr = redactor(result.stderr ?? "");
	return {
		phase,
		ok: result.status === 0,
		command: process.execPath,
		args: redactArgs(args),
		logDir,
		status: result.status,
		signal: result.signal,
		stdout: trimOutput(stdout),
		stderr: trimOutput(stderr),
		payload: parseJsonOutput(stdout) ?? parseJsonOutput(stderr),
	};
}

function checkSummarySecretLeak(text, secret, summaryFile, checks) {
	const needles = typeof secret === "string"
		? [secret, secret.trim()].filter((value) => value.length >= 3)
		: [];
	if (needles.length === 0) {
		const result = { ok: true, skipped: true, reason: "no secret supplied" };
		addCheck(checks, "summary:secret-leak", true, {
			file: summaryFile,
			...result,
		});
		return result;
	}
	const leaked = needles.some((needle) => text.includes(needle));
	const result = {
		ok: !leaked,
		file: summaryFile,
		leaked: leaked ? true : false,
		error: leaked ? "secret material must not appear in acceptance summary" : undefined,
	};
	addCheck(checks, "summary:secret-leak", result.ok, result);
	return result;
}

function resolveLocalHelper(name) {
	for (const candidate of [
		join("scripts", name),
		name,
		join(SCRIPT_DIR, name),
		join(SCRIPT_DIR, "scripts", name),
	]) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`required local helper not found: ${name}. Run from the repo root or from a release asset directory containing the Oracle helpers.`);
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = "true";
			continue;
		}
		if (arg === "--require-full") {
			out["require-full"] = "true";
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

function addCheck(checks, name, ok, detail = {}) {
	checks.push({ name, ok: Boolean(ok), ...detail });
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
		if (arg === "--secret-file") {
			redacted.push(arg, "[secret-file]");
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
	console.log(`Usage: node scripts/verify-headless-host-oracle-acceptance.mjs [options]

Options:
  --summary-file <path>   Acceptance summary JSON. Defaults to
                          <evidence-root>/acceptance-summary.json or
                          ./acceptance-summary.json.
  --evidence-root <path>  Local evidence root containing install/,
                          post-reboot/, and update/ directories. Defaults to
                          the summary file directory.
  --secret-file <path>    Sync token file for summary and child verifier
                          secret-leak checks.
  --require-full          Require preflight, install, reboot, post-reboot, and
                          update phases to be present in this exact order.
  --help, -h              Print this help.
`);
}

main().catch((err) => {
	console.error(JSON.stringify({
		kind: "headless-host-oracle-acceptance-verify",
		ok: false,
		failedStep: "fatal",
		error: err instanceof Error ? err.message : String(err),
	}, null, 2));
	process.exitCode = 1;
});
