#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const ASSETS = {
	binary: "kaos-headless-host.mjs",
	checksum: "kaos-headless-host.mjs.sha256",
	manifest: "kaos-headless-host-manifest.json",
	plugin: "kaos-plugin.zip",
	service: "kaos-headless-host.service",
	helpers: [
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
	],
};

let errorRedactor = redactNoop;

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}
	for (const legacy of ["token", "token-file", "postflight-token-file"]) {
		if (raw[legacy] !== undefined) throw new Error(`--${legacy} is no longer supported; postflight uses the approved service identity.`);
	}
	if (process.env.KAOS_SYNC_TOKEN || process.env.SYNC_TOKEN) {
		throw new Error("Legacy shared credential environment variables are not permitted for release updates.");
	}
	errorRedactor = await createUpdateRedactor(raw);

	const installDir = resolve(raw["install-dir"] ?? "/opt/kaos");
	const serviceEnabled = raw["no-service"] !== "true";
	const servicePath = serviceEnabled
		? resolve(raw["service-path"] ?? "/etc/systemd/system/kaos-headless-host.service")
		: undefined;
	const helpersEnabled = raw["no-helper-scripts"] !== "true";
	const metadataPath = raw["metadata-path"] ? resolve(raw["metadata-path"]) : undefined;
	const explicitInstaller = raw.installer ? resolve(raw.installer) : undefined;
	const token = raw["github-token"] ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	const dryRun = raw["dry-run"] === "true";
	const postflightOnly = raw["postflight-only"] === "true";
	const manifestEnabled = raw["no-manifest"] !== "true";
	const postflightEnabled = raw.postflight === "true" || raw["rollback-on-postflight-failure"] === "true";
	const rollbackOnPostflightFailure = raw["rollback-on-postflight-failure"] === "true";
	const rollbackPostflightEnabled = rollbackOnPostflightFailure && raw["no-rollback-postflight"] !== "true";
	const enableService = raw["enable-service"] === "true";
	const enableServiceName = raw["postflight-service"] ?? inferServiceName(servicePath) ?? "kaos-headless-host";
	const enableSystemctl = raw["postflight-systemctl"] ?? "systemctl";
	const bundleDir = raw["bundle-dir"] ? resolve(raw["bundle-dir"]) : null;
	const pluginUpdateRequested = raw["no-plugin-update"] !== "true";
	const pluginVaultRoot = resolve(raw["postflight-vault"] ?? "/srv/kaos/vault");
	const pluginDir = pluginUpdateRequested
		? resolve(raw["plugin-dir"] ?? join(pluginVaultRoot, ".obsidian", "plugins", "kaos"))
		: null;
	if (enableService && !serviceEnabled) {
		throw new Error("--enable-service requires a systemd service; remove --no-service.");
	}
	if (postflightOnly) {
		assertPostflightOnlyArgs(raw);
		if (dryRun) throw new Error("--postflight-only cannot be combined with --dry-run.");
		if (enableService) throw new Error("--postflight-only cannot be combined with --enable-service.");
		if (rollbackOnPostflightFailure) throw new Error("--postflight-only cannot be combined with --rollback-on-postflight-failure.");
		const postflightScript = resolve(defaultPostflightScript(raw, installDir, helpersEnabled));
		let postflight;
		try {
			postflight = runJsonScript("postflight", postflightScript, buildPostflightArgs({
				raw,
				installDir,
				helpersEnabled,
				servicePath,
				metadataPath,
			}));
		} catch (err) {
			throw new ReleaseUpdateError("postflight-only verification failed", {
				mode: "postflight-only",
				postflightOnly: true,
				installDir,
				servicePath: servicePath ?? null,
				postflight: describeScriptFailure(err),
				metadataPath: raw["postflight-metadata-path"] ?? metadataPath ?? null,
			});
		}
		console.log(JSON.stringify(redactObject({
			kind: "headless-host-release-update",
			ok: true,
			mode: "postflight-only",
			postflightOnly: true,
			verifiedAt: new Date().toISOString(),
			installDir,
			servicePath: servicePath ?? null,
			postflight,
			metadataPath: raw["postflight-metadata-path"] ?? metadataPath ?? null,
		}, errorRedactor), null, 2));
		return;
	}

	const bundleVerification = bundleDir ? await verifyBundleBeforeInstall(raw, bundleDir) : null;
	const baseUrl = resolveDownloadBase(raw);
	const workDir = resolve(raw["work-dir"] ?? await mkdtemp(join(tmpdir(), "kaos-headless-release-")));
	await mkdir(workDir, { recursive: true });
	const binaryPath = join(workDir, ASSETS.binary);
	const checksumPath = join(workDir, ASSETS.checksum);
	const pluginZipPath = join(workDir, ASSETS.plugin);
	const serviceSource = serviceEnabled ? join(workDir, ASSETS.service) : undefined;

	const downloaded = [];
	let releaseManifest = null;
	if (manifestEnabled) {
		const url = assetUrl(baseUrl, ASSETS.manifest);
		const path = join(workDir, ASSETS.manifest);
		await download(url, path, token);
		downloaded.push({ asset: ASSETS.manifest, url: redactUrl(url), path, sha256: await sha256File(path) });
		releaseManifest = await readReleaseManifest(path);
	}
	// Older release manifests did not list the plugin bundle. Keep their
	// runner-only updater compatible; current manifests always include it and
	// therefore make plugin replacement part of the verified transaction.
	const pluginUpdateEnabled = pluginUpdateRequested
		&& (!releaseManifest || Boolean(releaseManifest.assets?.[ASSETS.plugin]));
	const selectedAssets = [
		ASSETS.binary,
		ASSETS.checksum,
		...(pluginUpdateEnabled ? [ASSETS.plugin] : []),
		...(serviceEnabled ? [ASSETS.service] : []),
		...(helpersEnabled ? ASSETS.helpers : []),
	];
	for (const asset of selectedAssets) {
		const url = assetUrl(baseUrl, asset);
		const path = join(workDir, asset);
		await download(url, path, token);
		downloaded.push({ asset, url: redactUrl(url), path, sha256: await sha256File(path) });
	}
	if (releaseManifest) {
		await verifyManifestAssets(releaseManifest, selectedAssets, workDir);
	}
	const installer = explicitInstaller ?? (helpersEnabled ? join(workDir, ASSETS.helpers[0]) : defaultInstallerPath());

	const installArgs = [
		"--source",
		binaryPath,
		"--checksum",
		checksumPath,
		"--install-dir",
		installDir,
	];
	if (serviceEnabled && servicePath && serviceSource) {
		installArgs.push("--service-source", serviceSource, "--service-path", servicePath);
		if (raw["service-node"]) installArgs.push("--service-node", resolve(raw["service-node"]));
	}
	if (metadataPath) {
		installArgs.push("--metadata-path", metadataPath);
	}

	let pluginInstall = null;
	let installPayload;
	let helpers;
	try {
		pluginInstall = pluginUpdateEnabled
			? await installPluginZip({ pluginZipPath, pluginDir, dryRun })
			: null;
		({ installPayload, helpers } = dryRun
			? await planReleaseInstall({ installer, installArgs, workDir, installDir, helpersEnabled })
			: await installRelease({ installer, installArgs, workDir, installDir, helpersEnabled }));
	} catch (err) {
		if (pluginInstall && !dryRun) await rollbackPluginInstall(pluginInstall).catch(() => undefined);
		throw err;
	}
	const updateMetadataPath = installPayload.metadataPath ? resolve(installPayload.metadataPath) : metadataPath;
	if (!dryRun && updateMetadataPath) {
		try {
			await writeReleaseMetadata(updateMetadataPath, {
				baseUrl,
				workDir,
				installDir,
				installer,
				servicePath: servicePath ?? null,
				downloaded,
				manifest: releaseManifest,
				bundleVerification,
				install: installPayload,
				helpers,
			});
		} catch (err) {
			const metadataWrite = describeError(err);
			const rollbackScript = resolve(defaultRollbackScript(raw, installDir, helpersEnabled));
			try {
				const rollback = runJsonScript("rollback", rollbackScript, buildRollbackArgs({
					raw,
					installDir,
					serviceEnabled,
					servicePath,
					helpersEnabled,
					metadataPath: updateMetadataPath,
				}));
				const pluginRollback = await rollbackPluginInstall(pluginInstall);
				throw new ReleaseUpdateError("release metadata write failed after install; rollback completed", {
					metadataWrite,
					rollback,
					pluginRollback,
					rollbackSummary: summarizeRollback(rollback),
					rolledBack: true,
				});
			} catch (rollbackErr) {
				if (rollbackErr instanceof ReleaseUpdateError) throw rollbackErr;
				const pluginRollback = await rollbackPluginInstall(pluginInstall).catch((pluginRollbackErr) => describeError(pluginRollbackErr));
				throw new ReleaseUpdateError("release metadata write failed after install and rollback failed", {
					metadataWrite,
					rollback: describeScriptFailure(rollbackErr),
					pluginRollback,
					rolledBack: false,
				});
			}
		}
	}

	let postflight = null;
	if (!dryRun && postflightEnabled) {
		const postflightScript = resolve(defaultPostflightScript(raw, installDir, helpersEnabled));
		try {
			postflight = runJsonScript("postflight", postflightScript, buildPostflightArgs({
				raw,
				installDir,
				helpersEnabled,
				servicePath,
				metadataPath: updateMetadataPath,
			}));
		} catch (err) {
			const postflightFailure = describeScriptFailure(err);
			if (!rollbackOnPostflightFailure) {
				throw new ReleaseUpdateError("postflight failed after release install", {
					postflight: postflightFailure,
				});
			}

			const rollbackScript = resolve(defaultRollbackScript(raw, installDir, helpersEnabled));
			let rollback;
			try {
				rollback = runJsonScript("rollback", rollbackScript, buildRollbackArgs({
					raw,
					installDir,
					serviceEnabled,
					servicePath,
					helpersEnabled,
					metadataPath: updateMetadataPath,
				}));
			} catch (rollbackErr) {
				const pluginRollback = await rollbackPluginInstall(pluginInstall).catch((pluginRollbackErr) => describeError(pluginRollbackErr));
				throw new ReleaseUpdateError("postflight failed after release install and rollback failed", {
					postflight: postflightFailure,
					rollback: describeScriptFailure(rollbackErr),
					pluginRollback,
					rolledBack: false,
				});
			}
			const pluginRollback = await rollbackPluginInstall(pluginInstall);

			let rollbackPostflight = null;
			if (rollbackPostflightEnabled) {
				try {
					rollbackPostflight = runJsonScript("rollback-postflight", postflightScript, buildPostflightArgs({
						raw,
						installDir,
						helpersEnabled,
						servicePath,
						metadataPath: updateMetadataPath,
					}));
				} catch (rollbackPostflightErr) {
					throw new ReleaseUpdateError("postflight failed after release install; rollback completed but recovery postflight failed", {
						postflight: postflightFailure,
						rollback,
						rollbackSummary: summarizeRollback(rollback),
						rollbackPostflight: describeScriptFailure(rollbackPostflightErr),
						rolledBack: true,
						recoveryVerified: false,
					});
				}
			}
			throw new ReleaseUpdateError("postflight failed after release install; rollback completed and recovery postflight passed", {
				postflight: postflightFailure,
				rollback,
				pluginRollback,
				rollbackSummary: summarizeRollback(rollback),
				rollbackPostflight,
				rolledBack: true,
				recoveryVerified: rollbackPostflightEnabled,
			});
		}
	}

	let serviceEnable = null;
	if (enableService) {
		if (dryRun) {
			serviceEnable = {
				ok: true,
				skipped: true,
				dryRun: true,
				systemctl: enableSystemctl,
				service: enableServiceName,
			};
		} else {
			try {
				serviceEnable = runServiceEnable(enableSystemctl, enableServiceName);
			} catch (err) {
				throw new ReleaseUpdateError("service enable failed after release install", {
					serviceEnable: describeScriptFailure(err),
				});
			}
		}
	}
	if (pluginInstall && !dryRun) await finalizePluginInstall(pluginInstall);

	console.log(JSON.stringify(redactObject({
		kind: "headless-host-release-update",
		ok: true,
		baseUrl: redactUrlString(baseUrl),
		workDir,
		installDir,
		installer,
		servicePath: servicePath ?? null,
		plugin: pluginInstall,
		downloaded,
		manifest: releaseManifest,
		bundleVerification,
		install: installPayload,
		helpers,
		postflight,
		serviceEnable,
		metadataPath: updateMetadataPath ?? null,
	}, errorRedactor), null, 2));
}

function assertPostflightOnlyArgs(raw) {
	const forbidden = [
		"base-url",
		"bundle-dir",
		"repo",
		"tag",
		"github-token",
		"work-dir",
		"installer",
		"bundle-verifier",
		"service-node",
		"no-manifest",
		"skip-bundle-verify",
		"no-service",
		"no-plugin-update",
		"plugin-dir",
		"no-rollback-postflight",
	];
	const used = forbidden.filter((key) => raw[key] !== undefined);
	if (used.length > 0) {
		throw new Error(`--postflight-only cannot be combined with update/install options: ${used.map((key) => `--${key}`).join(", ")}`);
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
		if (arg === "--no-manifest") {
			out["no-manifest"] = "true";
			continue;
		}
		if (arg === "--skip-bundle-verify") {
			out["skip-bundle-verify"] = "true";
			continue;
		}
		if (arg === "--postflight") {
			out.postflight = "true";
			continue;
		}
		if (arg === "--postflight-only") {
			out["postflight-only"] = "true";
			continue;
		}
		if (arg === "--rollback-on-postflight-failure") {
			out["rollback-on-postflight-failure"] = "true";
			continue;
		}
		if (arg === "--no-rollback-postflight") {
			out["no-rollback-postflight"] = "true";
			continue;
		}
		if (arg === "--enable-service") {
			out["enable-service"] = "true";
			continue;
		}
		if (arg === "--postflight-skip-systemctl") {
			out["postflight-skip-systemctl"] = "true";
			continue;
		}
		if (arg === "--postflight-skip-smoke") {
			out["postflight-skip-smoke"] = "true";
			continue;
		}
		if (arg === "--postflight-check-only") {
			out["postflight-check-only"] = "true";
			continue;
		}
		if (arg === "--postflight-verify-running") {
			out["postflight-verify-running"] = "true";
			continue;
		}
		if (arg === "--postflight-skip-service-file-check") {
			out["postflight-skip-service-file-check"] = "true";
			continue;
		}
		if (arg === "--postflight-skip-metadata-check") {
			out["postflight-skip-metadata-check"] = "true";
			continue;
		}
		if (arg === "--postflight-skip-service-identity-check") {
			out["postflight-skip-service-identity-check"] = "true";
			continue;
		}
		if (arg === "--postflight-require-service-identity-check") {
			out["postflight-require-service-identity-check"] = "true";
			continue;
		}
		if (arg === "--postflight-skip-service-access-check") {
			out["postflight-skip-service-access-check"] = "true";
			continue;
		}
		if (arg === "--postflight-require-service-access-check") {
			out["postflight-require-service-access-check"] = "true";
			continue;
		}
		if (arg === "--postflight-no-smoke-user") {
			out["postflight-no-smoke-user"] = "true";
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

function releaseDownloadBase(raw) {
	const repo = raw.repo ?? process.env.KAOS_RELEASE_REPO ?? process.env.GITHUB_REPOSITORY;
	if (!repo) {
		throw new Error("Choose a release source with --bundle-dir, --base-url, --repo, KAOS_RELEASE_REPO, or GITHUB_REPOSITORY.");
	}
	const tag = raw.tag ?? process.env.KAOS_RELEASE_TAG ?? "latest";
	if (tag === "latest") {
		return `https://github.com/${repo}/releases/latest/download`;
	}
	return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
}

function resolveDownloadBase(raw) {
	if (raw["bundle-dir"]) {
		if (raw["base-url"] || raw.repo || raw.tag) {
			throw new Error("--bundle-dir cannot be combined with --base-url, --repo, or --tag.");
		}
		return pathToFileURL(`${resolve(raw["bundle-dir"]).replace(/\/$/, "")}/`).href;
	}
	return raw["base-url"] ?? releaseDownloadBase(raw);
}

function assetUrl(baseUrl, asset) {
	return new URL(asset, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function defaultInstallerPath() {
	return fileURLToPath(new URL("./install-headless-host.mjs", import.meta.url));
}

async function verifyBundleBeforeInstall(raw, bundleDir) {
	if (raw["skip-bundle-verify"] === "true") {
		return {
			kind: "headless-host-bundle-verify",
			ok: true,
			skipped: true,
			reason: "--skip-bundle-verify",
			bundleDir,
		};
	}
	const verifierScript = await defaultBundleVerifierScript(raw, bundleDir);
	try {
		return runJsonScript("bundle-verify", verifierScript, ["--bundle-dir", bundleDir]);
	} catch (err) {
		throw new ReleaseUpdateError("bundle verification failed before release install", {
			bundleDir,
			bundleVerification: describeScriptFailure(err),
		});
	}
}

async function defaultBundleVerifierScript(raw, bundleDir) {
	if (raw["bundle-verifier"]) return resolve(raw["bundle-verifier"]);
	const wrapperAdjacent = fileURLToPath(new URL("./verify-headless-host-bundle.mjs", import.meta.url));
	if (await pathExists(wrapperAdjacent)) return wrapperAdjacent;
	return join(bundleDir, "verify-headless-host-bundle.mjs");
}

async function download(url, targetPath, token) {
	await mkdir(dirname(targetPath), { recursive: true });
	const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
	try {
		if (url.protocol === "file:") {
			await copyFile(fileURLToPath(url), tempPath);
		} else {
			const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
			const res = await fetch(url, { headers });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ${res.statusText}`);
			}
			const bytes = new Uint8Array(await res.arrayBuffer());
			await writeFile(tempPath, bytes);
		}
		await rename(tempPath, targetPath);
	} catch (err) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw new Error(`failed to download ${redactUrlString(url.href)}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function readReleaseManifest(path) {
	let parsed;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (err) {
		throw new Error(`failed to read release manifest ${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (parsed?.kind !== "kaos-headless-host-release-manifest" || parsed.schemaVersion !== 1 || !parsed.assets || typeof parsed.assets !== "object") {
		throw new Error(`invalid headless release manifest: ${path}`);
	}
	return parsed;
}

async function verifyManifestAssets(manifest, assets, workDir) {
	for (const asset of assets) {
		const expected = manifest.assets[asset]?.sha256;
		if (typeof expected !== "string" || !/^[a-fA-F0-9]{64}$/.test(expected)) {
			throw new Error(`release manifest does not contain a sha256 for ${asset}`);
		}
		const actual = await sha256File(join(workDir, asset));
		if (actual !== expected.toLowerCase()) {
			throw new Error(`sha256 mismatch for release asset ${asset}: expected ${expected.toLowerCase()}, got ${actual}`);
		}
	}
}

const PLUGIN_FILES = ["manifest.json", "main.js", "telemetry.js", "styles.css"];

async function installPluginZip({ pluginZipPath, pluginDir, dryRun }) {
	if (!pluginDir) throw new Error("pluginDir is required when plugin updates are enabled");
	const zipEntries = new Map(PLUGIN_FILES.map((file) => [file, readZipEntry(pluginZipPath, file)]));
	const transactionId = `${process.pid}-${Date.now()}`;
	const entries = await Promise.all(PLUGIN_FILES.map(async (file) => {
		const target = join(pluginDir, file);
		return {
			file,
			target,
			tempPath: join(pluginDir, `.${file}.kaos-update-${transactionId}.tmp`),
			backupPath: join(pluginDir, `.${file}.kaos-update-${transactionId}.previous`),
			existed: await pathExists(target),
		};
	}));
	if (dryRun) return { pluginDir, dryRun: true, entries };
	await mkdir(pluginDir, { recursive: true });
	try {
		for (const entry of entries) {
			await rm(entry.tempPath, { force: true });
			await rm(entry.backupPath, { force: true });
			await writeFile(entry.tempPath, zipEntries.get(entry.file));
		}
		for (const entry of entries) {
			if (entry.existed) await rename(entry.target, entry.backupPath);
			await rename(entry.tempPath, entry.target);
		}
		return { pluginDir, dryRun: false, entries };
	} catch (err) {
		await rollbackPluginInstall({ pluginDir, dryRun: false, entries }).catch(() => undefined);
		throw err;
	}
}

function readZipEntry(zipPath, entry) {
	const result = spawnSync("unzip", ["-p", zipPath, entry], {
		encoding: null,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) {
		throw new Error(`unable to read ${entry} from plugin zip: ${result.error.message}`);
	}
	if (result.status !== 0 || !result.stdout || result.stdout.length === 0) {
		const detail = result.stderr?.toString("utf8").trim();
		throw new Error(`plugin zip is missing or unreadable: ${entry}${detail ? ` (${detail})` : ""}`);
	}
	return result.stdout;
}

async function rollbackPluginInstall(pluginInstall) {
	if (!pluginInstall || pluginInstall.dryRun) return { restored: false, skipped: true };
	for (const entry of [...pluginInstall.entries].reverse()) {
		await rm(entry.tempPath, { force: true }).catch(() => undefined);
		if (entry.existed && await pathExists(entry.backupPath)) {
			await rm(entry.target, { force: true });
			await rename(entry.backupPath, entry.target);
		} else if (!entry.existed) {
			await rm(entry.target, { force: true });
		}
	}
	return { restored: true, pluginDir: pluginInstall.pluginDir };
}

async function finalizePluginInstall(pluginInstall) {
	if (!pluginInstall || pluginInstall.dryRun) return;
	for (const entry of pluginInstall.entries) {
		await rm(entry.tempPath, { force: true }).catch(() => undefined);
		await rm(entry.backupPath, { force: true }).catch(() => undefined);
	}
}

async function installHelperScripts(workDir, installDir, dryRun) {
	const installed = [];
	const rollbackTargets = [];
	if (!dryRun) {
		await mkdir(installDir, { recursive: true });
	}
	try {
		for (const helper of ASSETS.helpers) {
			const source = join(workDir, helper);
			const target = join(installDir, helper);
			const existed = await pathExists(target);
			const backupPath = `${target}.previous`;
			const sourceSha256 = await sha256File(source);
			if (dryRun) {
				installed.push({
					source,
					target,
					backupPath: existed ? backupPath : null,
					sourceSha256,
					installed: false,
				});
				continue;
			}
			const tempPath = `${target}.tmp-${process.pid}-${Date.now()}-${basename(helper)}`;
			let movedOldTarget = false;
			try {
				await copyFile(source, tempPath);
				await chmod(tempPath, 0o755);
				if (existed) {
					await rm(backupPath, { force: true });
					await rename(target, backupPath);
					movedOldTarget = true;
				}
				await rename(tempPath, target);
				rollbackTargets.push({ target, backupPath, existed });
				const installedMode = (await stat(target)).mode & 0o777;
				installed.push({
					source,
					target,
					backupPath: existed ? backupPath : null,
					sourceSha256,
					installedSha256: await sha256File(target),
					installed: true,
					mode: `0${installedMode.toString(8)}`,
				});
			} catch (err) {
				await rm(tempPath, { force: true }).catch(() => undefined);
				if (movedOldTarget && !(await pathExists(target)) && await pathExists(backupPath)) {
					await rename(backupPath, target).catch(() => undefined);
				}
				throw err;
			}
		}
		return installed;
	} catch (err) {
		const rolledBack = await rollbackInstalledHelpers(rollbackTargets);
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`helper install failed after rolling back ${rolledBack.length} helper(s): ${message}`);
	}
}

async function planReleaseInstall({ installer, installArgs, workDir, installDir, helpersEnabled }) {
	return {
		installPayload: runInstaller(installer, [...installArgs, "--dry-run"]),
		helpers: helpersEnabled ? await installHelperScripts(workDir, installDir, true) : [],
	};
}

async function installRelease({ installer, installArgs, workDir, installDir, helpersEnabled }) {
	runInstaller(installer, [...installArgs, "--dry-run"]);
	const helpers = helpersEnabled ? await installHelperScripts(workDir, installDir, false) : [];
	try {
		return {
			installPayload: runInstaller(installer, installArgs),
			helpers,
		};
	} catch (err) {
		if (helpers.length > 0) {
			await rollbackInstalledHelpers(helperRollbackEntries(helpers));
		}
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`installer failed after helper install; rolled back ${helpers.length} helper(s): ${message}`);
	}
}

function runInstaller(installer, args) {
	const install = spawnSync(process.execPath, ["--", installer, ...args], {
		encoding: "utf8",
	});
	if (install.status !== 0) {
		throw new Error(install.stderr || install.stdout || `installer exited with status ${install.status}`);
	}
	try {
		return JSON.parse(install.stdout);
	} catch (err) {
		throw new Error(`installer did not print JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function buildPostflightArgs({ raw, installDir, helpersEnabled, servicePath, metadataPath }) {
	const args = [
		"--binary",
		raw["postflight-binary"] ?? join(installDir, ASSETS.binary),
		"--vault",
		raw["postflight-vault"] ?? "/srv/kaos/vault",
		"--data-file",
		raw["postflight-data-file"] ?? "/var/lib/kaos-headless/data.json",
		"--lock-file",
		raw["postflight-lock-file"] ?? "/run/kaos-headless/kaos.lock",
		"--env-file",
		raw["postflight-env-file"] ?? "/etc/kaos/headless.env",
		"--identity-file",
		raw["postflight-identity-file"] ?? "/var/lib/kaos-headless/device-identity.json",
		"--smoke-script",
		defaultSmokeScript(raw, installDir, helpersEnabled),
	];
	const selectedMetadataPath = raw["postflight-metadata-path"] ?? metadataPath;
	if (selectedMetadataPath) args.push("--metadata-path", selectedMetadataPath);
	if (servicePath) args.push("--service-file", servicePath);
	if (raw["postflight-service"]) args.push("--service", raw["postflight-service"]);
	if (raw["postflight-node"]) args.push("--node", raw["postflight-node"]);
	if (raw["postflight-min-node-major"]) args.push("--min-node-major", raw["postflight-min-node-major"]);
	if (raw["postflight-systemctl"]) args.push("--systemctl", raw["postflight-systemctl"]);
	if (raw["postflight-runuser"]) args.push("--runuser", raw["postflight-runuser"]);
	if (raw["postflight-smoke-user"]) args.push("--smoke-user", raw["postflight-smoke-user"]);
	if (raw["postflight-smoke-work-dir"]) args.push("--smoke-work-dir", raw["postflight-smoke-work-dir"]);
	if (raw["postflight-timeout-ms"]) args.push("--timeout-ms", raw["postflight-timeout-ms"]);
	if (raw["postflight-check-only"] === "true") args.push("--check-only");
	if (raw["postflight-verify-running"] === "true") args.push("--verify-running");
	if (raw["postflight-skip-systemctl"] === "true") args.push("--skip-systemctl");
	if (raw["postflight-skip-smoke"] === "true") args.push("--skip-smoke");
	if (raw["postflight-skip-service-file-check"] === "true") args.push("--skip-service-file-check");
	if (raw["postflight-skip-metadata-check"] === "true") args.push("--skip-metadata-check");
	if (raw["postflight-skip-service-identity-check"] === "true") args.push("--skip-service-identity-check");
	if (raw["postflight-require-service-identity-check"] === "true") args.push("--require-service-identity-check");
	if (raw["postflight-skip-service-access-check"] === "true") args.push("--skip-service-access-check");
	if (raw["postflight-require-service-access-check"] === "true") args.push("--require-service-access-check");
	if (raw["postflight-no-smoke-user"] === "true") args.push("--no-smoke-user");
	return args;
}

function defaultPostflightScript(raw, installDir, helpersEnabled) {
	return raw["postflight-script"] ?? defaultHelperScript("postflight-headless-host.mjs", installDir, helpersEnabled);
}

function defaultRollbackScript(raw, installDir, helpersEnabled) {
	return raw["rollback-script"] ?? defaultHelperScript("rollback-headless-host.mjs", installDir, helpersEnabled);
}

function defaultSmokeScript(raw, installDir, helpersEnabled) {
	return raw["postflight-smoke-script"] ?? defaultHelperScript("smoke-headless-host-sync.mjs", installDir, helpersEnabled);
}

function defaultHelperScript(name, installDir, helpersEnabled) {
	return helpersEnabled ? join(installDir, name) : fileURLToPath(new URL(`./${name}`, import.meta.url));
}

function buildRollbackArgs({ raw, installDir, serviceEnabled, servicePath, helpersEnabled, metadataPath }) {
	const args = ["--install-dir", installDir];
	if (serviceEnabled && servicePath) {
		args.push("--service-path", servicePath);
	} else {
		args.push("--no-service");
	}
	if (!helpersEnabled) args.push("--no-helper-scripts");
	if (metadataPath) {
		args.push("--metadata-path", metadataPath);
	} else {
		args.push("--no-metadata");
	}
	if (raw["rollback-stamp"]) args.push("--rollback-stamp", raw["rollback-stamp"]);
	return args;
}

function runJsonScript(stage, script, args) {
	const result = spawnSync(process.execPath, ["--", script, ...args], {
		encoding: "utf8",
	});
	const detail = {
		stage,
		script,
		args,
		status: result.status,
		signal: result.signal,
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
		payload: parseJsonPayload(result.stdout) ?? parseJsonPayload(result.stderr),
	};
	if (result.error) {
		throw new ScriptCommandError(stage, `${stage} failed to start: ${result.error.message}`, detail);
	}
	if (result.status !== 0) {
		throw new ScriptCommandError(stage, `${stage} failed`, detail);
	}
	if (!detail.payload) {
		throw new ScriptCommandError(stage, `${stage} did not print JSON`, detail);
	}
	return detail.payload;
}

function runCommand(stage, command, args) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
	});
	const detail = {
		stage,
		command,
		args,
		status: result.status,
		signal: result.signal,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
	};
	if (result.error) {
		throw new ScriptCommandError(stage, `${stage} failed to start: ${result.error.message}`, detail);
	}
	if (result.status !== 0) {
		throw new ScriptCommandError(stage, `${stage} failed`, detail);
	}
	return {
		...detail,
		ok: true,
	};
}

function runServiceEnable(systemctl, service) {
	const commands = [];
	try {
		commands.push(runCommand("enable-service", systemctl, ["enable", service]));
		commands.push(runCommand("verify-service-enabled", systemctl, ["is-enabled", "--quiet", service]));
		return {
			ok: true,
			systemctl,
			service,
			commands,
		};
	} catch (err) {
		if (err instanceof ScriptCommandError) {
			throw new ScriptCommandError(err.stage, err.message, {
				...err.detail,
				systemctl,
				service,
				completed: commands,
			});
		}
		throw err;
	}
}

function parseJsonPayload(text) {
	const trimmed = text.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

class ScriptCommandError extends Error {
	constructor(stage, message, detail) {
		super(message);
		this.stage = stage;
		this.detail = detail;
	}
}

class ReleaseUpdateError extends Error {
	constructor(message, detail) {
		super(message);
		this.detail = detail;
	}
}

function describeScriptFailure(err) {
	if (err instanceof ScriptCommandError) {
		return err.detail.payload ?? {
			stage: err.stage,
			...(err.detail.script ? { script: err.detail.script } : {}),
			...(err.detail.command ? { command: err.detail.command } : {}),
			args: err.detail.args,
			status: err.detail.status,
			signal: err.detail.signal,
			stdout: err.detail.stdout,
			stderr: err.detail.stderr,
			...(err.detail.systemctl ? { systemctl: err.detail.systemctl } : {}),
			...(err.detail.service ? { service: err.detail.service } : {}),
			...(err.detail.completed ? { completed: err.detail.completed } : {}),
		};
	}
	return {
		error: err instanceof Error ? err.message : String(err),
	};
}

function describeError(err) {
	return {
		error: err instanceof Error ? err.message : String(err),
	};
}

async function createUpdateRedactor(raw) {
	const secrets = [
		raw["github-token"],
		process.env.GITHUB_TOKEN,
		process.env.GH_TOKEN,
	];
	const values = [...new Set(secrets.filter((value) => typeof value === "string" && value.length > 0))];
	if (values.length === 0) return redactNoop;
	return (text) => values.reduce((out, secret) => out.split(secret).join("[redacted]"), String(text));
}

function redactObject(value, redactor) {
	if (typeof value === "string") return redactor(value);
	if (Array.isArray(value)) return value.map((item) => redactObject(item, redactor));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObject(item, redactor)]));
	}
	return value;
}

function redactNoop(text) {
	return String(text);
}

function summarizeRollback(rollback) {
	const restored = Array.isArray(rollback?.restored) ? rollback.restored : [];
	return {
		restoredCount: restored.filter((entry) => entry.restored).length,
		skippedCount: restored.filter((entry) => entry.skipped).length,
		failedCount: restored.filter((entry) => entry.error).length,
		failedArtifacts: restored
			.filter((entry) => entry.failedPath)
			.map((entry) => ({
				kind: entry.kind ?? null,
				target: entry.target,
				failedPath: entry.failedPath,
			})),
	};
}

function helperRollbackEntries(helpers) {
	return helpers
		.filter((helper) => helper.installed)
		.map((helper) => ({
			target: helper.target,
			backupPath: helper.backupPath,
			existed: helper.backupPath !== null,
		}));
}

async function rollbackInstalledHelpers(entries) {
	const rolledBack = [];
	const stamp = `${Date.now()}-${process.pid}`;
	for (const entry of entries.slice().reverse()) {
		try {
			if (entry.existed) {
				const failedPath = `${entry.target}.failed-helper-${stamp}`;
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
			rolledBack.push({ target: entry.target, restored: entry.existed });
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

async function writeReleaseMetadata(path, payload) {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${basename(path)}`;
	try {
		await writeFile(tempPath, `${JSON.stringify({
			kind: "headless-host-release-install",
			runtime: "kaos-headless-host",
			updatedAt: new Date().toISOString(),
			baseUrl: redactUrlString(payload.baseUrl),
			workDir: payload.workDir,
			installDir: payload.installDir,
			installer: payload.installer,
			servicePath: payload.servicePath,
			downloaded: payload.downloaded,
			manifest: payload.manifest,
			bundleVerification: payload.bundleVerification,
			install: payload.install,
			helpers: payload.helpers,
		}, null, 2)}\n`, "utf8");
		await chmod(tempPath, 0o644);
		await rename(tempPath, path);
	} catch (err) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw err;
	}
}

async function sha256File(path) {
	const bytes = await readFile(path);
	return createHash("sha256").update(bytes).digest("hex");
}

function redactUrl(url) {
	return redactUrlString(url.href);
}

function redactUrlString(value) {
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		return url.href;
	} catch {
		return value;
	}
}

function inferServiceName(servicePath) {
	if (!servicePath) return null;
	const name = basename(servicePath);
	return name.endsWith(".service") ? name.slice(0, -".service".length) : name;
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
	console.log(`Usage: node scripts/update-headless-host-from-release.mjs [options]

Options:
  --repo <owner/repo>       GitHub repository. Defaults to KAOS_RELEASE_REPO or GITHUB_REPOSITORY.
  --tag <tag>               Release tag. Defaults to latest.
  --base-url <url>          Direct release asset base URL. Overrides --repo/--tag.
  --bundle-dir <path>       Unpacked kaos-headless-host-oracle.zip directory for offline install/update.
                            Bundle mode automatically runs verify-headless-host-bundle.mjs before install.
  --bundle-verifier <path>  Override verifier used by --bundle-dir. Defaults to the wrapper-adjacent
                            verifier, falling back to <bundle-dir>/verify-headless-host-bundle.mjs.
  --skip-bundle-verify      Skip automatic --bundle-dir verification. Reserved for emergency recovery.
  --github-token <token>    Token for private GitHub releases. Defaults to GITHUB_TOKEN/GH_TOKEN.
  --work-dir <path>         Download workspace. Defaults to a temp directory.
  --install-dir <path>      Directory for kaos-headless-host.mjs. Defaults to /opt/kaos.
  --service-path <path>     systemd service destination. Defaults to
                            /etc/systemd/system/kaos-headless-host.service.
  --service-node <path>     Rewrite installed service ExecStart/ExecStartPre to use this Node binary.
                            Service commands must use "<node> -- <script>" form.
	--plugin-dir <path>       Vault KAOS plugin directory. Defaults under --postflight-vault.
	--no-plugin-update        Leave the vault KAOS plugin untouched (emergency compatibility escape hatch).
  --no-manifest             Do not download or verify kaos-headless-host-manifest.json.
  --no-service              Do not download or install the systemd service file.
  --no-helper-scripts       Do not download or install install/uninstall/update/verify/rehearsal/smoke/postflight/rollback helper scripts.
                            Helper defaults then resolve next to this update wrapper.
  --metadata-path <path>    Install metadata JSON path.
  --installer <path>        Local install-headless-host.mjs path.
  --postflight              Run postflight after a successful install.
  --postflight-only         Run postflight against the installed files without
                            downloading, installing, writing metadata, or restarting via update flow.
                            Cannot be combined with release source or install-only options.
  --rollback-on-postflight-failure
                            Run postflight and restore .previous artifacts if postflight fails.
  --no-rollback-postflight  Do not re-run postflight after an automatic rollback.
  --enable-service          Run "systemctl enable <service>" and verify
                            "systemctl is-enabled --quiet <service>" after a successful install/postflight.
                            The service name defaults to --postflight-service or --service-path basename.
                            Uses --postflight-systemctl when that override is set.
  --postflight-vault <path> Vault path for postflight. Defaults to /srv/kaos/vault.
  --postflight-data-file <path>
                            Data file for postflight. Defaults to /var/lib/kaos-headless/data.json.
  --postflight-lock-file <path>
                            Lock file for postflight. Defaults to /run/kaos-headless/kaos.lock.
  --postflight-env-file <path>
                            Env file for postflight. Defaults to /etc/kaos/headless.env.
  --postflight-identity-file <path>
                            Protected service identity for postflight. Defaults to /var/lib/kaos-headless/device-identity.json.
  --postflight-metadata-path <path>
                            Install metadata file for postflight. Defaults to the update metadata path.
  --postflight-smoke-script <path>
                            Smoke helper path. Defaults below --install-dir, or next to this wrapper with --no-helper-scripts.
  --postflight-smoke-work-dir <path>
                            Deprecated compatibility option; when supplied it must be outside the vault.
  --postflight-script <path>
                            Postflight helper path. Defaults below --install-dir, or next to this wrapper with --no-helper-scripts.
  --rollback-script <path>  Rollback helper path. Defaults below --install-dir, or next to this wrapper with --no-helper-scripts.
  --postflight-service <name>
                            systemd service name for postflight.
  --postflight-node <path>  Node binary for postflight.
  --postflight-min-node-major <n>
                            Minimum Node.js major version accepted by postflight. Defaults to 20.
  --postflight-systemctl <path>
                            systemctl command for postflight.
  --postflight-runuser <path>
                            runuser command for postflight smoke.
  --postflight-smoke-user <user>
                            User for postflight smoke.
  --postflight-no-smoke-user
                            Do not switch user for postflight smoke.
  --postflight-check-only
                            Run postflight pre-restart checks without systemctl or smoke.
  --postflight-verify-running
                            Run postflight against an already-running service without restart.
  --postflight-skip-systemctl
                            Skip systemctl checks during postflight.
  --postflight-skip-service-file-check
                            Skip service file/path coherence checks during postflight.
  --postflight-skip-metadata-check
                            Skip install metadata sha256/path coherence checks during postflight.
  --postflight-skip-service-identity-check
                            Skip service User=/Group= existence checks during postflight.
  --postflight-require-service-identity-check
                            Run service identity checks even when postflight is not root.
  --postflight-skip-service-access-check
                            Skip service User= file access checks during postflight.
  --postflight-require-service-access-check
                            Run service User= file access checks even when postflight is not root.
  --postflight-skip-smoke   Skip sync smoke during postflight.
  --postflight-timeout-ms <ms>
                            Timeout passed to postflight.
  --rollback-stamp <stamp>  Suffix used by automatic rollback .failed files.
  --dry-run                 Download and verify without replacing installed files.
  --help, -h                Print this help.
`);
}

main().catch((err) => {
	console.error(JSON.stringify(redactObject({
		kind: "headless-host-release-update",
		ok: false,
		error: err instanceof Error ? err.message : String(err),
		...(err instanceof ReleaseUpdateError ? err.detail : {}),
	}, errorRedactor)));
	process.exitCode = 1;
});
