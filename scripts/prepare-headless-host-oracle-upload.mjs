#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { unzipSync } from "fflate";

const DEFAULT_ZIP = "dist/kaos-headless-host-oracle.zip";
const REQUIRED_ENTRIES = [
	"kaos-headless-host.mjs",
	"kaos-headless-host.mjs.sha256",
	"kaos-headless-host-manifest.json",
	"kaos-headless-host.service",
	"oracle-acceptance-config.example.json",
	"kaos-headless-host-bundle-manifest.json",
	"README-headless-host.txt",
	"bootstrap-headless-host-oracle.mjs",
	"install-headless-host.mjs",
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

const README_SNIPPETS = [
	"uninstall-headless-host.mjs",
	"verify-headless-host-bundle.mjs",
	"validate-headless-host-release-assets.mjs",
	"run-headless-host-oracle-rehearsal.mjs",
	"run-headless-host-oracle-remote-rehearsal.mjs",
	"run-headless-host-oracle-acceptance.mjs",
	"verify-headless-host-oracle-acceptance.mjs",
	"oracle-acceptance-config.example.json",
	"acceptance-config.json",
	"--config ./acceptance-config.json",
	"--validate-local",
	"--resume-from-summary",
	"--release-dir .",
	"--skip-local-prepare",
	"--zip ./kaos-headless-host-oracle.zip",
	"--checksum ./kaos-headless-host-oracle.zip.sha256",
	"--phase post-reboot",
	"--postflight-verify-running",
	"--rollback-on-postflight-failure",
	"--enable-service",
	"--purge-vault",
];

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}

	const zipPath = resolve(raw.zip ?? DEFAULT_ZIP);
	const checksumPath = resolve(raw.checksum ?? `${zipPath}.sha256`);
	const target = raw.target ?? null;
	const workDir = raw["work-dir"]
		? resolve(raw["work-dir"])
		: await mkdtemp(join(tmpdir(), "kaos-headless-oracle-upload-"));
	const keepWorkDir = raw["keep-work-dir"] === "true" || Boolean(raw["work-dir"]);

	try {
		const zipInfo = await stat(zipPath);
		if (!zipInfo.isFile()) {
			await fail({
				failedStage: "zip-file",
				error: "zip path is not a file",
				zipPath,
			});
			return;
		}

		const zipBytes = await readFile(zipPath);
		const zipSha256 = sha256Bytes(zipBytes);
		const checksumText = await readFile(checksumPath, "utf8");
		const expectedZipSha256 = readChecksum(checksumText);
		if (zipSha256 !== expectedZipSha256) {
			await fail({
				failedStage: "zip-checksum",
				error: "zip sha256 does not match checksum file",
				zipPath,
				checksumPath,
				expectedZipSha256,
				actualZipSha256: zipSha256,
			});
			return;
		}

		const entries = unzip(zipBytes);
		const entryNames = Object.keys(entries).sort();
		const failures = [];
		for (const entry of entryNames) {
			try {
				assertSafeZipEntryName(entry);
			} catch (err) {
				failures.push({
					stage: "zip-entry",
					entry,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		for (const required of REQUIRED_ENTRIES) {
			if (!entries[required]) {
				failures.push({
					stage: "bundle-entry",
					entry: required,
					error: "required Oracle bundle entry is missing",
				});
			}
		}
		if (entries["README-headless-host.txt"]) {
			const readme = textEntry(entries, "README-headless-host.txt");
			for (const snippet of README_SNIPPETS) {
				if (!readme.includes(snippet)) {
					failures.push({
						stage: "bundle-readme",
						entry: "README-headless-host.txt",
						error: `README is missing ${snippet}`,
					});
				}
			}
		}
		if (failures.length > 0) {
			await fail({
				failedStage: failures[0].stage,
				error: "Oracle bundle contents are not upload-ready",
				zipPath,
				checksumPath,
				failures,
			});
			return;
		}

		await mkdir(workDir, { recursive: true });
		for (const entry of entryNames) {
			const outPath = join(workDir, entry);
			await writeFile(outPath, entries[entry]);
			if (entry.endsWith(".mjs")) {
				await chmod(outPath, 0o755);
			}
		}

		const bundleVerification = runBundleVerifier(workDir);
		if (!bundleVerification.ok) {
			await fail({
				failedStage: "bundle-verify",
				error: "bundled verifier rejected the extracted Oracle bundle",
				zipPath,
				checksumPath,
				workDir: keepWorkDir ? workDir : null,
				bundleVerification,
			});
			return;
		}

		const payload = {
			kind: "headless-host-oracle-upload-prepare",
			ok: true,
			zipPath,
			checksumPath,
			zipBytes: zipInfo.size,
			zipSha256,
			workDir: keepWorkDir ? workDir : null,
			keepWorkDir,
			localNode: process.version,
			requiredEntries: REQUIRED_ENTRIES,
			entries: entryNames.map((entry) => ({
				entry,
				bytes: entries[entry].length,
				sha256: sha256Bytes(entries[entry]),
			})),
			bundleVerification: summarizeBundleVerification(bundleVerification.payload),
			uploadFiles: [zipPath, checksumPath],
			uploadTarget: target,
			uploadCommand: target ? `scp ${shellQuote(zipPath)} ${shellQuote(checksumPath)} ${shellQuote(target)}` : null,
		};
		console.log(JSON.stringify(payload, null, 2));
	} finally {
		if (!keepWorkDir) {
			await rm(workDir, { recursive: true, force: true });
		}
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
		if (arg === "--keep-work-dir") {
			out["keep-work-dir"] = "true";
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

function unzip(bytes) {
	try {
		return unzipSync(bytes);
	} catch (err) {
		throw new Error(`Oracle bundle zip is not readable: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function runBundleVerifier(workDir) {
	const verifier = join(workDir, "verify-headless-host-bundle.mjs");
	const result = spawnSync(process.execPath, ["--", verifier, "--bundle-dir", workDir], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const payload = parseJsonOutput(result.stdout) ?? parseJsonOutput(result.stderr);
	return {
		ok: result.status === 0 && payload?.ok === true,
		status: result.status,
		signal: result.signal,
		payload,
		...(payload ? {} : {
			stdout: trimOutput(result.stdout),
			stderr: trimOutput(result.stderr),
		}),
	};
}

function summarizeBundleVerification(payload) {
	return {
		kind: payload.kind,
		ok: payload.ok === true,
		checkedCount: Array.isArray(payload.checked) ? payload.checked.length : 0,
		releaseCheckCount: Array.isArray(payload.releaseChecks) ? payload.releaseChecks.length : 0,
		checksumCheck: payload.checksumCheck ?? null,
	};
}

function parseJsonOutput(text) {
	const trimmed = text.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

function assertSafeZipEntryName(entry) {
	if (typeof entry !== "string" || entry.length === 0 || entry !== basename(entry) || entry.includes("/") || entry.includes("\\") || entry.includes("\0")) {
		throw new Error(`unsafe zip entry name: ${String(entry)}`);
	}
	if (entry === "." || entry === "..") {
		throw new Error(`unsafe zip entry name: ${entry}`);
	}
}

function textEntry(entries, entry) {
	return Buffer.from(entries[entry]).toString("utf8");
}

function readChecksum(text) {
	const match = text.match(/[a-fA-F0-9]{64}/);
	if (!match) {
		throw new Error("checksum file does not contain a sha256 digest");
	}
	return match[0].toLowerCase();
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function shellQuote(value) {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
		? value
		: `'${value.replace(/'/g, "'\\''")}'`;
}

function trimOutput(text) {
	const trimmed = text.trim();
	return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}...` : trimmed;
}

async function fail(payload) {
	console.error(JSON.stringify({
		kind: "headless-host-oracle-upload-prepare",
		ok: false,
		...payload,
	}, null, 2));
	process.exitCode = 1;
}

function printUsage() {
	console.log(`Usage: node scripts/prepare-headless-host-oracle-upload.mjs [options]

Options:
  --zip <path>          Oracle bundle zip. Defaults to dist/kaos-headless-host-oracle.zip.
  --checksum <path>     Zip sha256 file. Defaults to <zip>.sha256.
  --work-dir <path>     Extraction workspace. When provided, it is preserved.
  --keep-work-dir       Preserve the temporary extraction workspace.
  --target <scp-target> Optional upload target, for example opc@example:/home/opc/.
                        When set, the JSON output includes a ready scp command.
  --help, -h            Print this help.
`);
}

main().catch((err) => {
	console.error(JSON.stringify({
		kind: "headless-host-oracle-upload-prepare",
		ok: false,
		failedStage: "fatal",
		error: err instanceof Error ? err.message : String(err),
	}, null, 2));
	process.exitCode = 1;
});
