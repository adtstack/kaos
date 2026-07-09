#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const DEFAULT_ZIP = "dist/kaos-headless-host-oracle.zip";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}

	const zipPath = resolve(raw.zip ?? DEFAULT_ZIP);
	const checksumPath = resolve(raw.checksum ?? `${zipPath}.sha256`);
	const checks = [];
	let zipBytes = null;
	let checksumText = null;

	try {
		zipBytes = await readFile(zipPath);
		addCheck(checks, "release-zip:readable", true, { path: zipPath, bytes: zipBytes.length });
	} catch (err) {
		addCheck(checks, "release-zip:readable", false, {
			path: zipPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	try {
		checksumText = await readFile(checksumPath, "utf8");
		addCheck(checks, "release-checksum:readable", true, { path: checksumPath, bytes: Buffer.byteLength(checksumText) });
	} catch (err) {
		addCheck(checks, "release-checksum:readable", false, {
			path: checksumPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	if (zipBytes && checksumText) {
		let expectedSha256 = null;
		try {
			expectedSha256 = readChecksum(checksumText);
			addCheck(checks, "release-checksum:parse", true, { path: checksumPath, expectedSha256 });
		} catch (err) {
			addCheck(checks, "release-checksum:parse", false, {
				path: checksumPath,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		if (expectedSha256) {
			const actualSha256 = sha256Bytes(zipBytes);
			const checksumOk = actualSha256 === expectedSha256;
			addCheck(checks, "release-zip:checksum", checksumOk, {
				zipPath,
				checksumPath,
				expectedSha256,
				actualSha256,
				error: "release zip sha256 must match checksum file",
			});
			if (checksumOk) {
				await addReleaseBundleVerifyCheck(checks, {
					zipPath,
					zipBytes,
					verifier: raw["bundle-verifier"] ? resolve(raw["bundle-verifier"]) : findLocalHelper("verify-headless-host-bundle.mjs"),
				});
			}
		}
	}

	const failedChecks = checks.filter((check) => !check.ok);
	const payload = {
		kind: "headless-host-release-assets-validate",
		ok: failedChecks.length === 0,
		zipPath,
		checksumPath,
		checks,
		failedChecks,
	};
	if (payload.ok) {
		console.log(JSON.stringify(payload, null, 2));
	} else {
		console.error(JSON.stringify(payload, null, 2));
		process.exitCode = 1;
	}
}

async function addReleaseBundleVerifyCheck(checks, { zipPath, zipBytes, verifier }) {
	if (!verifier || !existsSync(verifier)) {
		addCheck(checks, "release-bundle-verify", false, {
			zipPath,
			verifier: verifier ?? null,
			error: "verify-headless-host-bundle.mjs is required to validate release bundle contents locally",
		});
		return;
	}
	let bundleDir = null;
	try {
		bundleDir = await mkdtemp(join(tmpdir(), "kaos-release-assets-"));
		await extractZipToDirectory(zipBytes, bundleDir);
		const result = spawnSync(process.execPath, [verifier, "--bundle-dir", bundleDir], {
			encoding: "utf8",
			timeout: 120_000,
		});
		const payload = parseJsonOutput(result.stdout ?? "") ?? parseJsonOutput(result.stderr ?? "");
		addCheck(checks, "release-bundle-verify", result.status === 0 && payload?.ok === true, {
			zipPath,
			verifier,
			status: result.status,
			signal: result.signal,
			payload: summarizeBundleVerification(payload),
			stdout: payload ? undefined : trimOutput(result.stdout ?? ""),
			stderr: payload ? undefined : trimOutput(result.stderr ?? ""),
			error: "release bundle verifier must pass before Oracle acceptance",
		});
	} catch (err) {
		addCheck(checks, "release-bundle-verify", false, {
			zipPath,
			verifier,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
	}
}

function summarizeBundleVerification(payload) {
	if (!payload || typeof payload !== "object") return payload;
	return {
		kind: payload.kind ?? null,
		ok: payload.ok === true,
		checkedCount: Array.isArray(payload.checked) ? payload.checked.length : null,
		releaseCheckCount: Array.isArray(payload.releaseChecks) ? payload.releaseChecks.length : null,
		checksumCheck: payload.checksumCheck
			? {
				asset: payload.checksumCheck.asset ?? null,
				ok: payload.checksumCheck.ok === true,
				expectedSha256: payload.checksumCheck.expectedSha256 ?? null,
				checksumSha256: payload.checksumCheck.checksumSha256 ?? null,
			}
			: null,
		...(Array.isArray(payload.failures) ? { failureCount: payload.failures.length, failedStage: payload.failedStage ?? null } : {}),
	};
}

async function extractZipToDirectory(zipBytes, targetDir) {
	const entries = readZipEntries(zipBytes);
	for (const entry of entries) {
		const parts = safeZipEntryParts(entry.name);
		if (parts.length === 0) continue;
		const outPath = join(targetDir, ...parts);
		if (entry.directory) {
			await mkdir(outPath, { recursive: true });
			continue;
		}
		await mkdir(dirname(outPath), { recursive: true });
		await writeFile(outPath, entry.bytes);
	}
}

function readZipEntries(zipBytes) {
	const eocd = findEndOfCentralDirectory(zipBytes);
	const totalEntries = zipBytes.readUInt16LE(eocd + 10);
	const centralDirectoryOffset = zipBytes.readUInt32LE(eocd + 16);
	const entries = [];
	let offset = centralDirectoryOffset;
	for (let i = 0; i < totalEntries; i++) {
		if (zipBytes.readUInt32LE(offset) !== 0x02014b50) {
			throw new Error("zip central directory is malformed");
		}
		const flags = zipBytes.readUInt16LE(offset + 8);
		const method = zipBytes.readUInt16LE(offset + 10);
		const compressedSize = zipBytes.readUInt32LE(offset + 20);
		const uncompressedSize = zipBytes.readUInt32LE(offset + 24);
		const nameLength = zipBytes.readUInt16LE(offset + 28);
		const extraLength = zipBytes.readUInt16LE(offset + 30);
		const commentLength = zipBytes.readUInt16LE(offset + 32);
		const localHeaderOffset = zipBytes.readUInt32LE(offset + 42);
		if ((flags & 0x1) !== 0) throw new Error("encrypted zip entries are not supported");
		if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
			throw new Error("zip64 bundle entries are not supported by local validation");
		}
		const name = zipBytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		const bytes = readZipEntryBytes(zipBytes, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
		entries.push({ name, bytes, directory: name.endsWith("/") });
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

function readZipEntryBytes(zipBytes, { name, method, compressedSize, uncompressedSize, localHeaderOffset }) {
	if (zipBytes.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
		throw new Error(`zip local header is malformed for ${name}`);
	}
	const nameLength = zipBytes.readUInt16LE(localHeaderOffset + 26);
	const extraLength = zipBytes.readUInt16LE(localHeaderOffset + 28);
	const dataOffset = localHeaderOffset + 30 + nameLength + extraLength;
	const compressed = zipBytes.subarray(dataOffset, dataOffset + compressedSize);
	let bytes;
	if (method === 0) {
		bytes = compressed;
	} else if (method === 8) {
		bytes = inflateRawSync(compressed);
	} else {
		throw new Error(`unsupported zip compression method ${method} for ${name}`);
	}
	if (bytes.length !== uncompressedSize) {
		throw new Error(`zip entry size mismatch for ${name}`);
	}
	return bytes;
}

function findEndOfCentralDirectory(zipBytes) {
	const min = Math.max(0, zipBytes.length - 65_557);
	for (let offset = zipBytes.length - 22; offset >= min; offset--) {
		if (zipBytes.readUInt32LE(offset) === 0x06054b50) return offset;
	}
	throw new Error("zip end of central directory was not found");
}

function safeZipEntryParts(name) {
	if (typeof name !== "string" || name.length === 0 || name.startsWith("/") || name.includes("\\")) {
		throw new Error(`unsafe zip entry name: ${String(name)}`);
	}
	const parts = name.split("/").filter((part) => part.length > 0);
	if (parts.some((part) => part === "." || part === "..")) {
		throw new Error(`unsafe zip entry name: ${name}`);
	}
	return parts;
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
	const check = { name, ok: Boolean(ok), ...detail };
	if (check.ok) delete check.error;
	checks.push(check);
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

function printUsage() {
	console.log(`Usage: node scripts/validate-headless-host-release-assets.mjs [options]

Options:
  --zip <path>              Oracle bundle zip. Defaults to dist/kaos-headless-host-oracle.zip.
  --checksum <path>         Oracle bundle checksum. Defaults to <zip>.sha256.
  --bundle-verifier <path>  verify-headless-host-bundle.mjs path. Defaults to a local helper.
  --help, -h                Print this help.
`);
}

main().catch((err) => {
	console.error(JSON.stringify({
		kind: "headless-host-release-assets-validate",
		ok: false,
		failedStage: "fatal",
		error: err instanceof Error ? err.message : String(err),
	}, null, 2));
	process.exitCode = 1;
});
