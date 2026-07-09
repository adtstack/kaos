#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";

const REQUIRED_FILES = [
	"01-zip-sha256.txt",
	"02-bundle-verify.json",
	"03-bootstrap.json",
	"04-secret-permissions.txt",
	"05-install-postflight.json",
	"06-install-metadata.json",
	"07-post-reboot-verify-running.json",
	"08-operational-smoke.json",
	"09-systemctl-status.txt",
	"10-journalctl.txt",
];
const REBOOT_REQUEST_FILE = "11-reboot-request.json";
const INSTALL_REQUIRED_FILES = [
	"01-zip-sha256.txt",
	"02-bundle-verify.json",
	"03-bootstrap.json",
	"04-secret-permissions.txt",
	"05-install-postflight.json",
	"06-install-metadata.json",
];
const UPDATE_REQUIRED_FILES = [
	"01-zip-sha256.txt",
	"02-bundle-verify.json",
	"04-secret-permissions.txt",
	"05-install-postflight.json",
	"06-install-metadata.json",
];
const RELEASE_ASSETS = [
	"kaos-headless-host.mjs",
	"kaos-headless-host.mjs.sha256",
	"kaos-headless-host.service",
	"oracle-acceptance-config.example.json",
	"install-headless-host.mjs",
	"bootstrap-headless-host-oracle.mjs",
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
const DOWNLOADED_ASSETS = [
	"kaos-headless-host-manifest.json",
	...RELEASE_ASSETS,
];

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}

	const logDir = resolve(raw["log-dir"] ?? ".");
	const mode = raw.mode ?? "full";
	if (!["full", "install", "update"].includes(mode)) {
		throw new Error(`unsupported --mode: ${mode}`);
	}
	const requireRebootRequest = raw["require-reboot-request"] === "true";
	if (requireRebootRequest && mode !== "full") {
		throw new Error("--require-reboot-request is only supported with --mode full.");
	}
	const baseRequiredFiles = mode === "update"
		? UPDATE_REQUIRED_FILES
		: mode === "install"
			? INSTALL_REQUIRED_FILES
			: REQUIRED_FILES;
	const requiredFiles = requireRebootRequest ? [...baseRequiredFiles, REBOOT_REQUEST_FILE] : baseRequiredFiles;
	const secret = await readSecret(raw);
	const checks = [];
	const texts = {};

	for (const file of requiredFiles) {
		const path = join(logDir, file);
		const text = await readText(path, file, checks);
		if (text !== null) texts[file] = text;
	}

	checkZipSha256(texts["01-zip-sha256.txt"], checks);
	checkBundleVerify(parseJson(texts["02-bundle-verify.json"], "02-bundle-verify.json", checks), checks);
	if (mode !== "update") {
		checkBootstrap(parseJson(texts["03-bootstrap.json"], "03-bootstrap.json", checks), checks);
	}
	checkSecretPermissions(texts["04-secret-permissions.txt"], checks);
	checkInstallPostflight(parseJson(texts["05-install-postflight.json"], "05-install-postflight.json", checks), checks);
	checkInstallMetadata(parseJson(texts["06-install-metadata.json"], "06-install-metadata.json", checks), checks);
	if (mode === "full") {
		const postRebootPayload = parseJson(texts["07-post-reboot-verify-running.json"], "07-post-reboot-verify-running.json", checks);
		checkPostReboot(postRebootPayload, checks);
		checkOperationalSmoke(parseJson(texts["08-operational-smoke.json"], "08-operational-smoke.json", checks), checks);
		checkSystemdEvidence(texts["09-systemctl-status.txt"], texts["10-journalctl.txt"], checks);
		if (requireRebootRequest) {
			checkRebootRequest(parseJson(texts[REBOOT_REQUEST_FILE], REBOOT_REQUEST_FILE, checks), postRebootPayload, checks);
		}
	}

	const secretLeakCheck = await checkSecretLeak(logDir, secret, checks);
	const failedChecks = checks.filter((check) => !check.ok);
	const payload = {
		kind: "headless-host-oracle-rehearsal-verify",
		ok: failedChecks.length === 0,
		mode,
		requireRebootRequest,
		logDir,
		requiredFiles,
		checks,
		secretLeakCheck,
		failedChecks,
	};
	if (payload.ok) {
		console.log(JSON.stringify(payload, null, 2));
	} else {
		console.error(JSON.stringify(payload, null, 2));
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
		if (arg === "--require-reboot-request") {
			out["require-reboot-request"] = "true";
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

async function readSecret(raw) {
	if (raw.secret !== undefined) return raw.secret;
	if (raw["secret-file"]) {
		return (await readFile(resolve(raw["secret-file"]), "utf8")).trim();
	}
	return null;
}

async function readText(path, file, checks) {
	try {
		const text = await readFile(path, "utf8");
		addCheck(checks, `file:${file}`, true, { file, path });
		return text;
	} catch (err) {
		addCheck(checks, `file:${file}`, false, {
			file,
			path,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

function parseJson(text, file, checks) {
	if (text === undefined || text === null) return null;
	try {
		const parsed = JSON.parse(text);
		addCheck(checks, `json:${file}`, true, { file });
		return parsed;
	} catch (err) {
		addCheck(checks, `json:${file}`, false, {
			file,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

function checkZipSha256(text, checks) {
	if (text === undefined) return;
	addCheck(checks, "zip-sha256", /\bOK\b/.test(text), {
		file: "01-zip-sha256.txt",
		error: "sha256sum output must contain OK",
	});
}

function checkBundleVerify(payload, checks) {
	if (!payload) return;
	addCheck(checks, "bundle-verify:shape", payload.kind === "headless-host-bundle-verify" && payload.ok === true, {
		file: "02-bundle-verify.json",
		kind: payload.kind ?? null,
		ok: payload.ok ?? null,
	});
	addCheck(checks, "bundle-verify:assets", allOk(payload.checked), {
		file: "02-bundle-verify.json",
		error: "every checked asset must be ok",
	});
	addCheck(checks, "bundle-verify:release-cross-check", allOk(payload.releaseChecks), {
		file: "02-bundle-verify.json",
		error: "every release manifest cross-check must be ok",
	});
	addCheck(checks, "bundle-verify:checksum", payload.checksumCheck?.ok === true, {
		file: "02-bundle-verify.json",
		error: "checksumCheck.ok must be true",
	});
}

function checkBootstrap(payload, checks) {
	if (!payload) return;
	addCheck(checks, "bootstrap", payload.kind === "headless-host-oracle-bootstrap" && payload.ok === true, {
		file: "03-bootstrap.json",
		kind: payload.kind ?? null,
		ok: payload.ok ?? null,
	});
}

function checkSecretPermissions(text, checks) {
	if (text === undefined) return;
	const hasEnv = text.includes("/etc/kaos/headless.env");
	const hasToken = text.includes("/etc/kaos/sync-token");
	const strictRootGroup = /root:kaos\s+0?640\s+\/etc\/kaos\/headless\.env/.test(text)
		&& /root:kaos\s+0?640\s+\/etc\/kaos\/sync-token/.test(text);
	addCheck(checks, "secret-permissions", hasEnv && hasToken && strictRootGroup, {
		file: "04-secret-permissions.txt",
		error: "expected root:kaos 0640 for env and token files",
		hasEnv,
		hasToken,
	});
}

function checkInstallPostflight(payload, checks) {
	if (!payload) return;
	addCheck(checks, "install-postflight:shape", payload.kind === "headless-host-release-update" && payload.ok === true, {
		file: "05-install-postflight.json",
		kind: payload.kind ?? null,
		ok: payload.ok ?? null,
	});
	addCheck(checks, "install-postflight:bundle", payload.bundleVerification?.ok === true, {
		file: "05-install-postflight.json",
		error: "bundleVerification.ok must be true",
	});
	addCheck(checks, "install-postflight:install", payload.install?.ok === true, {
		file: "05-install-postflight.json",
		error: "install.ok must be true",
	});
	addCheck(checks, "install-postflight:postflight", payload.postflight?.ok === true, {
		file: "05-install-postflight.json",
		error: "postflight.ok must be true",
	});
	addCheck(checks, "install-postflight:readiness", payload.postflight?.readiness?.mode === "full", {
		file: "05-install-postflight.json",
		mode: payload.postflight?.readiness?.mode ?? null,
	});
	addCheck(checks, "install-postflight:smoke", payload.postflight?.smoke?.ok === true, {
		file: "05-install-postflight.json",
		error: "postflight.smoke.ok must be true",
	});
	addCheck(checks, "install-postflight:service-enable", payload.serviceEnable?.ok === true, {
		file: "05-install-postflight.json",
		error: "serviceEnable.ok must be true",
	});
}

function checkInstallMetadata(payload, checks) {
	if (!payload) return;
	const helpers = Array.isArray(payload.helpers) ? payload.helpers : [];
	const downloaded = Array.isArray(payload.downloaded) ? payload.downloaded : [];
	const manifestAssets = payload.manifest?.assets && typeof payload.manifest.assets === "object"
		? payload.manifest.assets
		: {};
	const downloadedByAsset = new Map(downloaded.map((item) => [item?.asset, item]));
	addCheck(checks, "install-metadata:shape", payload.kind === "headless-host-release-install", {
		file: "06-install-metadata.json",
		kind: payload.kind ?? null,
	});
	addCheck(checks, "install-metadata:release-manifest", payload.manifest?.kind === "kaos-headless-host-release-manifest" && payload.manifest?.schemaVersion === 1, {
		file: "06-install-metadata.json",
		kind: payload.manifest?.kind ?? null,
		schemaVersion: payload.manifest?.schemaVersion ?? null,
	});
	addCheck(checks, "install-metadata:downloaded-assets", DOWNLOADED_ASSETS.every((asset) => isSha256(downloadedByAsset.get(asset)?.sha256)), {
		file: "06-install-metadata.json",
		downloadedCount: downloaded.length,
		requiredAssets: DOWNLOADED_ASSETS,
		error: "downloaded must include every required release asset with sha256",
	});
	addCheck(checks, "install-metadata:manifest-assets", RELEASE_ASSETS.every((asset) => isSha256(manifestAssets[asset]?.sha256)), {
		file: "06-install-metadata.json",
		requiredAssets: RELEASE_ASSETS,
		error: "release manifest must include every installed asset sha256",
	});
	addCheck(checks, "install-metadata:bundle", payload.bundleVerification?.ok === true, {
		file: "06-install-metadata.json",
		error: "bundleVerification.ok must be true",
	});
	addCheck(checks, "install-metadata:install", payload.install?.ok === true, {
		file: "06-install-metadata.json",
		error: "install.ok must be true",
	});
	addCheck(checks, "install-metadata:binary-sha256", isSha256(payload.install?.sha256) && payload.install.sha256 === manifestAssets["kaos-headless-host.mjs"]?.sha256, {
		file: "06-install-metadata.json",
		installSha256: payload.install?.sha256 ?? null,
		manifestSha256: manifestAssets["kaos-headless-host.mjs"]?.sha256 ?? null,
		error: "installed binary sha256 must match release manifest",
	});
	addCheck(checks, "install-metadata:helpers", helpers.length > 0 && helpers.every((helper) => typeof helper.installedSha256 === "string"), {
		file: "06-install-metadata.json",
		helperCount: helpers.length,
		error: "helpers must include installed sha256 values",
	});
	addCheck(checks, "install-metadata:helper-manifest-sha256", helpers.length > 0 && helpers.every((helper) => {
		const asset = basename(String(helper.target ?? ""));
		const expected = manifestAssets[asset]?.sha256;
		return isSha256(expected) && helper.sourceSha256 === expected && helper.installedSha256 === expected;
	}), {
		file: "06-install-metadata.json",
		helperCount: helpers.length,
		error: "helper source and installed sha256 values must match the release manifest",
	});
}

function checkPostReboot(payload, checks) {
	if (!payload) return;
	addCheck(checks, "post-reboot:shape", payload.kind === "headless-host-release-update" && payload.ok === true && payload.mode === "postflight-only" && payload.postflightOnly === true, {
		file: "07-post-reboot-verify-running.json",
		kind: payload.kind ?? null,
		ok: payload.ok ?? null,
		mode: payload.mode ?? null,
		postflightOnly: payload.postflightOnly ?? null,
	});
	addCheck(checks, "post-reboot:postflight", payload.postflight?.ok === true, {
		file: "07-post-reboot-verify-running.json",
		error: "postflight.ok must be true",
	});
	addCheck(checks, "post-reboot:verify-running", payload.postflight?.readiness?.mode === "verify-running" && payload.postflight?.readiness?.bootServiceEnabled === true, {
		file: "07-post-reboot-verify-running.json",
		mode: payload.postflight?.readiness?.mode ?? null,
		bootServiceEnabled: payload.postflight?.readiness?.bootServiceEnabled ?? null,
	});
	addCheck(checks, "post-reboot:smoke", payload.postflight?.smoke?.ok === true, {
		file: "07-post-reboot-verify-running.json",
		error: "postflight.smoke.ok must be true",
	});
}

function checkOperationalSmoke(payload, checks) {
	if (!payload) return;
	const stages = Array.isArray(payload.completedStages) ? payload.completedStages : [];
	addCheck(checks, "operational-smoke:shape", payload.kind === "headless-host-sync-smoke" && payload.ok === true, {
		file: "08-operational-smoke.json",
		kind: payload.kind ?? null,
		ok: payload.ok ?? null,
	});
	for (const stage of ["oracle-to-peer:wait-peer", "peer-to-oracle:wait-primary"]) {
		addCheck(checks, `operational-smoke:${stage}`, stages.includes(stage), {
			file: "08-operational-smoke.json",
			error: `completedStages must include ${stage}`,
		});
	}
}

function checkSystemdEvidence(statusText, journalText, checks) {
	if (statusText !== undefined) {
		addCheck(checks, "systemd-status:service", statusText.includes("kaos-headless-host") || statusText.includes(".service"), {
			file: "09-systemctl-status.txt",
			error: "systemctl status evidence must identify the service",
		});
		addCheck(checks, "systemd-status:active", /Active:\s+active\b/.test(statusText), {
			file: "09-systemctl-status.txt",
			error: "systemctl status evidence must show Active: active",
		});
	}
	if (journalText !== undefined) {
		addCheck(checks, "journalctl:evidence", journalText.trim().length > 0, {
			file: "10-journalctl.txt",
			error: "journalctl evidence must not be empty",
		});
	}
}

function checkRebootRequest(payload, postRebootPayload, checks) {
	if (!payload) return;
	addCheck(checks, "reboot-request:shape", payload.kind === "headless-host-oracle-remote-reboot-request" && payload.ok === true, {
		file: REBOOT_REQUEST_FILE,
		kind: payload.kind ?? null,
		ok: payload.ok ?? null,
	});
	addCheck(checks, "reboot-request:remote-dir", typeof payload.remoteDir === "string" && payload.remoteDir.length > 0, {
		file: REBOOT_REQUEST_FILE,
		remoteDir: payload.remoteDir ?? null,
		error: "remoteDir must identify the reboot rehearsal directory",
	});
	addCheck(checks, "reboot-request:timestamp", typeof payload.requestedAt === "string" && !Number.isNaN(Date.parse(payload.requestedAt)), {
		file: REBOOT_REQUEST_FILE,
		requestedAt: payload.requestedAt ?? null,
		error: "requestedAt must be an ISO-like timestamp",
	});
	addCheck(checks, "reboot-request:systemctl", typeof payload.systemctlPath === "string" && payload.systemctlPath.length > 0, {
		file: REBOOT_REQUEST_FILE,
		systemctlPath: payload.systemctlPath ?? null,
		error: "systemctlPath must be captured",
	});
	const requestedAtMs = Date.parse(String(payload.requestedAt ?? ""));
	const verifiedAt = postRebootPayload?.verifiedAt;
	const verifiedAtMs = Date.parse(String(verifiedAt ?? ""));
	addCheck(checks, "reboot-request:post-reboot-after-request", Number.isFinite(requestedAtMs) && Number.isFinite(verifiedAtMs) && verifiedAtMs >= requestedAtMs, {
		file: "07-post-reboot-verify-running.json",
		rebootRequestFile: REBOOT_REQUEST_FILE,
		requestedAt: payload.requestedAt ?? null,
		verifiedAt: verifiedAt ?? null,
		error: "post-reboot verification must include verifiedAt at or after the reboot request time",
	});
}

async function checkSecretLeak(logDir, secret, checks) {
	if (!secret) {
		const result = { ok: true, skipped: true, reason: "no secret supplied" };
		addCheck(checks, "secret-leak", true, result);
		return result;
	}
	if (secret.length < 8) {
		const result = { ok: false, skipped: false, reason: "secret is too short to check safely" };
		addCheck(checks, "secret-leak", false, result);
		return result;
	}
	const files = await listFiles(logDir);
	const leakedFiles = [];
	for (const file of files) {
		const path = join(logDir, file);
		try {
			const text = await readFile(path, "utf8");
			if (text.includes(secret)) leakedFiles.push(file);
		} catch {
			continue;
		}
	}
	const result = {
		ok: leakedFiles.length === 0,
		skipped: false,
		checkedFiles: files.length,
		leakedFiles,
	};
	addCheck(checks, "secret-leak", result.ok, {
		checkedFiles: result.checkedFiles,
		leakedFiles,
		error: "secret material must not appear in rehearsal logs",
	});
	return result;
}

async function listFiles(dir, prefix = "") {
	const out = [];
	for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...await listFiles(dir, rel));
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
	return out;
}

function allOk(value) {
	return Array.isArray(value) && value.length > 0 && value.every((item) => item?.ok === true);
}

function isSha256(value) {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function addCheck(checks, name, ok, detail = {}) {
	checks.push({ name, ok: Boolean(ok), ...detail });
}

function printUsage() {
	console.log(`Usage: node scripts/verify-headless-host-oracle-rehearsal.mjs [options]

Options:
  --log-dir <path>      Directory containing Oracle rehearsal evidence files.
                       Defaults to the current directory.
  --mode <full|install|update>
                       Verification mode. full requires first install,
                       post-reboot, and operational smoke evidence. install
                       verifies first install evidence before reboot. update
                       verifies bundle/update/postflight evidence only.
                       Defaults to full.
  --require-reboot-request
                       With --mode full, require and validate
                       11-reboot-request.json from the remote reboot phase.
  --secret-file <path>  Optional sync token file. When supplied, every evidence
                       file is scanned to ensure the token text was not logged.
  --secret <value>      Optional sync token value. Prefer --secret-file.
  --help, -h            Print this help.
`);
}

main().catch((err) => {
	console.error(JSON.stringify({
		kind: "headless-host-oracle-rehearsal-verify",
		ok: false,
		failedStage: "fatal",
		error: err instanceof Error ? err.message : String(err),
	}, null, 2));
	process.exitCode = 1;
});
