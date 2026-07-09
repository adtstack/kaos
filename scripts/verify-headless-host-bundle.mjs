#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";

const DEFAULT_BUNDLE_MANIFEST = "kaos-headless-host-bundle-manifest.json";
const DEFAULT_RELEASE_MANIFEST = "kaos-headless-host-manifest.json";
const DEFAULT_BINARY = "kaos-headless-host.mjs";
const DEFAULT_CHECKSUM = "kaos-headless-host.mjs.sha256";

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}

	const bundleDir = resolve(raw["bundle-dir"] ?? ".");
	const manifestPath = resolve(raw.manifest ?? join(bundleDir, DEFAULT_BUNDLE_MANIFEST));
	const releaseManifestPath = resolve(raw["release-manifest"] ?? join(bundleDir, DEFAULT_RELEASE_MANIFEST));
	const failures = [];
	const checked = [];
	const releaseChecks = [];
	let checksumCheck = null;

	const manifest = await readJson(manifestPath, "bundle manifest");
	validateManifestShape(manifest, {
		label: "bundle manifest",
		expectedKind: "kaos-headless-host-oracle-bundle",
		failures,
	});

	for (const [asset, expected] of Object.entries(manifest.assets ?? {})) {
		const result = await verifyBundleAsset(bundleDir, asset, expected);
		checked.push(result.check);
		if (result.failure) failures.push(result.failure);
	}

	const releaseManifest = await readJson(releaseManifestPath, "release manifest");
	validateManifestShape(releaseManifest, {
		label: "release manifest",
		expectedKind: "kaos-headless-host-release-manifest",
		failures,
	});

	for (const [asset, expected] of Object.entries(releaseManifest.assets ?? {})) {
		const bundled = manifest.assets?.[asset];
		const check = {
			asset,
			releaseSha256: normalizeSha256(expected?.sha256),
			bundleSha256: normalizeSha256(bundled?.sha256),
			releaseBytes: expected?.bytes,
			bundleBytes: bundled?.bytes,
			ok: Boolean(bundled)
				&& normalizeSha256(expected?.sha256) === normalizeSha256(bundled?.sha256)
				&& expected?.bytes === bundled?.bytes,
		};
		releaseChecks.push(check);
		if (!check.ok) {
			failures.push({
				stage: "release-manifest-cross-check",
				asset,
				error: bundled
					? "release manifest asset does not match bundle manifest"
					: "release manifest asset is missing from bundle manifest",
				releaseSha256: check.releaseSha256,
				bundleSha256: check.bundleSha256 ?? null,
				releaseBytes: check.releaseBytes,
				bundleBytes: check.bundleBytes ?? null,
			});
		}
	}

	checksumCheck = await verifyChecksumFile(bundleDir, manifest.assets ?? {});
	if (!checksumCheck.ok) {
		failures.push({
			stage: "checksum-file",
			asset: DEFAULT_CHECKSUM,
			error: checksumCheck.error,
			expectedSha256: checksumCheck.expectedSha256 ?? null,
			checksumSha256: checksumCheck.checksumSha256 ?? null,
		});
	}

	const payload = {
		kind: "headless-host-bundle-verify",
		ok: failures.length === 0,
		bundleDir,
		manifestPath,
		releaseManifestPath,
		checked,
		releaseChecks,
		checksumCheck,
	};
	if (failures.length > 0) {
		payload.failedStage = failures[0].stage;
		payload.failures = failures;
		console.error(JSON.stringify(payload, null, 2));
		process.exitCode = 1;
		return;
	}

	console.log(JSON.stringify(payload, null, 2));
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

async function readJson(path, label) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (err) {
		throw new Error(`${label} is not readable JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function validateManifestShape(manifest, { label, expectedKind, failures }) {
	if (!manifest || typeof manifest !== "object") {
		failures.push({ stage: "manifest-shape", manifest: label, error: "manifest must be an object" });
		return;
	}
	if (manifest.kind !== expectedKind) {
		failures.push({ stage: "manifest-kind", manifest: label, error: `expected ${expectedKind}`, actual: manifest.kind ?? null });
	}
	if (manifest.schemaVersion !== 1) {
		failures.push({ stage: "manifest-schema", manifest: label, error: "expected schemaVersion 1", actual: manifest.schemaVersion ?? null });
	}
	if (manifest.runtime !== "kaos-headless-host") {
		failures.push({ stage: "manifest-runtime", manifest: label, error: "expected runtime kaos-headless-host", actual: manifest.runtime ?? null });
	}
	if (!manifest.assets || typeof manifest.assets !== "object" || Array.isArray(manifest.assets)) {
		failures.push({ stage: "manifest-assets", manifest: label, error: "assets must be an object" });
	}
}

async function verifyBundleAsset(bundleDir, asset, expected) {
	const baseCheck = {
		asset,
		path: null,
		expectedSha256: normalizeSha256(expected?.sha256),
		actualSha256: null,
		expectedBytes: expected?.bytes,
		actualBytes: null,
		ok: false,
	};
	try {
		assertSafeAssetName(asset);
		const assetPath = join(bundleDir, asset);
		baseCheck.path = assetPath;
		const info = await stat(assetPath);
		if (!info.isFile()) {
			return {
				check: baseCheck,
				failure: { stage: "asset-integrity", asset, path: assetPath, error: "asset is not a file" },
			};
		}
		const bytes = await readFile(assetPath);
		const actualSha256 = sha256Bytes(bytes);
		baseCheck.actualSha256 = actualSha256;
		baseCheck.actualBytes = info.size;
		baseCheck.ok = expected?.bytes === info.size && normalizeSha256(expected?.sha256) === actualSha256;
		if (!baseCheck.ok) {
			return {
				check: baseCheck,
				failure: {
					stage: "asset-integrity",
					asset,
					path: assetPath,
					error: "asset bytes or sha256 mismatch",
					expectedSha256: baseCheck.expectedSha256,
					actualSha256,
					expectedBytes: expected?.bytes,
					actualBytes: info.size,
				},
			};
		}
		return { check: baseCheck, failure: null };
	} catch (err) {
		return {
			check: baseCheck,
			failure: {
				stage: "asset-integrity",
				asset,
				path: baseCheck.path,
				error: err instanceof Error ? err.message : String(err),
			},
		};
	}
}

async function verifyChecksumFile(bundleDir, assets) {
	const binarySha256 = normalizeSha256(assets[DEFAULT_BINARY]?.sha256);
	const checksumPath = join(bundleDir, DEFAULT_CHECKSUM);
	try {
		assertSafeAssetName(DEFAULT_CHECKSUM);
		await access(checksumPath);
		const checksumText = await readFile(checksumPath, "utf8");
		const checksumSha256 = readChecksum(checksumText);
		const ok = Boolean(binarySha256) && checksumSha256 === binarySha256;
		return {
			asset: DEFAULT_CHECKSUM,
			path: checksumPath,
			expectedSha256: binarySha256 ?? null,
			checksumSha256,
			ok,
			...(ok ? {} : { error: "checksum file does not match binary sha256" }),
		};
	} catch (err) {
		return {
			asset: DEFAULT_CHECKSUM,
			path: checksumPath,
			expectedSha256: binarySha256 ?? null,
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function assertSafeAssetName(asset) {
	if (typeof asset !== "string" || asset.length === 0 || asset !== basename(asset) || asset.includes("/") || asset.includes("\\")) {
		throw new Error(`unsafe bundle asset name: ${String(asset)}`);
	}
	if (asset === "." || asset === "..") {
		throw new Error(`unsafe bundle asset name: ${asset}`);
	}
}

function readChecksum(text) {
	const match = text.match(/[a-fA-F0-9]{64}/);
	if (!match) {
		throw new Error("checksum file does not contain a sha256 digest");
	}
	return match[0].toLowerCase();
}

function normalizeSha256(value) {
	return typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value) ? value.toLowerCase() : null;
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function printUsage() {
	console.log(`Usage: node scripts/verify-headless-host-bundle.mjs [options]

Options:
  --bundle-dir <path>       Unpacked kaos-headless-host-oracle.zip directory.
                            Defaults to the current directory.
  --manifest <path>         Bundle manifest path. Defaults to
                            <bundle-dir>/kaos-headless-host-bundle-manifest.json.
  --release-manifest <path> Release manifest path. Defaults to
                            <bundle-dir>/kaos-headless-host-manifest.json.
  --help, -h                Print this help.
`);
}

main().catch((err) => {
	console.error(JSON.stringify({
		kind: "headless-host-bundle-verify",
		ok: false,
		failedStage: "fatal",
		error: err instanceof Error ? err.message : String(err),
	}, null, 2));
	process.exitCode = 1;
});
