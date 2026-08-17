import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	appendR2Binding,
	autoBindR2,
	extractBucketNamesFromListOutput,
	extractR2BucketName,
	extractVersionIds,
	hasR2Binding,
	readWorkerName,
	resolveBucketName,
} from "../server/scripts/auto-bind-r2.mjs";

const rootDir = resolve(".");
const artifactPath = resolve(rootDir, "dist/release-assets/kaos-server.zip");
const updateManifestPath = resolve(rootDir, "dist/release-assets/update-manifest.json");
const tempDir = mkdtempSync(join(tmpdir(), "kaos-server-update-test-"));
const repoDir = join(tempDir, "repo");

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: repoDir,
		stdio: "inherit",
		...options,
	});
}

function runExpectFailure(command, args, options = {}) {
	try {
		execFileSync(command, args, {
			cwd: repoDir,
			encoding: "utf8",
			stdio: "pipe",
			...options,
		});
	} catch (err) {
		return `${err.stdout ?? ""}${err.stderr ?? ""}`;
	}
	throw new Error(`Expected command to fail: ${command} ${args.join(" ")}`);
}

function read(relativePath) {
	return readFileSync(join(repoDir, relativePath), "utf8");
}

function readRequiredNumberConst(source, name) {
	const match = source.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`));
	if (!match) {
		throw new Error(`Unable to read ${name} from src/version.ts`);
	}
	return Number(match[1]);
}

function buildBadSchemaArtifact(baselineVersion, schemaVersion) {
	const badReleaseDir = join(tempDir, "bad-schema-release");
	const badArtifactPath = join(tempDir, "bad-schema-server.zip");
	mkdirSync(join(badReleaseDir, "src"), { recursive: true });
	const badVersion = baselineVersion
		.replace(/SERVER_VERSION = "[^"]+"/, 'SERVER_VERSION = "99.0.0"')
		.replace(/SERVER_MIN_SCHEMA_VERSION\s*=\s*\d+/, `SERVER_MIN_SCHEMA_VERSION = ${schemaVersion}`)
		.replace(/SERVER_MAX_SCHEMA_VERSION\s*=\s*\d+/, `SERVER_MAX_SCHEMA_VERSION = ${schemaVersion}`);
	writeFileSync(join(badReleaseDir, "src/version.ts"), badVersion);
	writeFileSync(
		join(badReleaseDir, "kaos-server-manifest.json"),
		`${JSON.stringify({
			serverVersion: "99.0.0",
			pluginVersion: "99.0.0",
			serverMinSchemaVersion: schemaVersion,
			serverMaxSchemaVersion: schemaVersion,
			protectedFiles: ["wrangler.toml"],
			updateOwnedPaths: ["src/version.ts"],
			migrationRequired: false,
		}, null, 2)}\n`,
	);
	execFileSync("zip", ["-qr", badArtifactPath, "."], {
		cwd: badReleaseDir,
		stdio: "inherit",
	});
	return badArtifactPath;
}

function testAutoR2BindingHelpers() {
	const baseWrangler = [
		'name = "kaos"',
		'main = "src/index.ts"',
		"",
		"[[durable_objects.bindings]]",
		'name = "KAOS_SYNC"',
		'class_name = "VaultSyncServer"',
		"",
	].join("\n");

	if (readWorkerName(baseWrangler) !== "kaos") {
		throw new Error("Auto R2 binding test failed: worker name was not parsed");
	}
	if (hasR2Binding(baseWrangler)) {
		throw new Error("Auto R2 binding test failed: false-positive R2 binding detected");
	}

	const appended = appendR2Binding(baseWrangler, "kaos-assets");
	if (!hasR2Binding(appended)) {
		throw new Error("Auto R2 binding test failed: appended binding was not detected");
	}
	if (!appended.includes('binding = "KAOS_BUCKET"') || !appended.includes('bucket_name = "kaos-assets"')) {
		throw new Error("Auto R2 binding test failed: appended TOML block is incomplete");
	}

	const currentDeployment = {
		versions: [{ version_id: "version-a" }],
		bindings: [
			{ type: "secret_text", name: "KAOS_BUCKET" },
			{ type: "r2_bucket", name: "KAOS_BUCKET", bucket_name: "kaos-existing-assets" },
		],
	};
	if (extractVersionIds(currentDeployment)[0] !== "version-a") {
		throw new Error("Auto R2 binding test failed: deployment version id was not extracted");
	}
	if (extractR2BucketName(currentDeployment) !== "kaos-existing-assets") {
		throw new Error("Auto R2 binding test failed: deployed R2 bucket name was not extracted");
	}

	const listedBuckets = extractBucketNamesFromListOutput(JSON.stringify([{ name: "KAOS_BUCKET" }]));
	if (listedBuckets[0] !== "KAOS_BUCKET") {
		throw new Error("Auto R2 binding test failed: R2 list JSON was not parsed");
	}

	const resolvedFromEnv = resolveBucketName({
		source: baseWrangler,
		env: { KAOS_R2_BUCKET_NAME: "kaos-env-assets" },
		currentDeployment: null,
		r2BucketListOutput: "",
	});
	if (resolvedFromEnv?.bucketName !== "kaos-env-assets" || resolvedFromEnv.source !== "env") {
		throw new Error("Auto R2 binding test failed: explicit env bucket was not preferred");
	}

	const resolvedFromDeployment = resolveBucketName({
		source: baseWrangler,
		env: {},
		currentDeployment,
		r2BucketListOutput: "",
	});
	if (resolvedFromDeployment?.bucketName !== "kaos-existing-assets") {
		throw new Error("Auto R2 binding test failed: current deployment bucket was not resolved");
	}

	const tempWranglerPath = join(tempDir, "auto-r2-wrangler.toml");
	writeFileSync(tempWranglerPath, baseWrangler);
	if (!autoBindR2(tempWranglerPath, { KAOS_R2_BUCKET_NAME: "kaos-auto-assets" })) {
		throw new Error("Auto R2 binding test failed: autoBindR2 did not write an env-selected bucket");
	}
	const autoBoundWrangler = readFileSync(tempWranglerPath, "utf8");
	if (!hasR2Binding(autoBoundWrangler) || !autoBoundWrangler.includes('bucket_name = "kaos-auto-assets"')) {
		throw new Error("Auto R2 binding test failed: autoBindR2 output was incomplete");
	}
	if (autoBindR2(tempWranglerPath, { KAOS_R2_BUCKET_NAME: "different-assets" })) {
		throw new Error("Auto R2 binding test failed: autoBindR2 rewrote an existing binding");
	}
}

try {
	const updateManifest = JSON.parse(readFileSync(updateManifestPath, "utf8"));
	if (
		updateManifest.migrationRequired !== true
		|| updateManifest.upgradeOrder !== "plugin-first"
		|| updateManifest.autoUpdateEligible !== false
	) {
		throw new Error(
			`Migration release manifest is not plugin-first and fail-closed: ${JSON.stringify(updateManifest)}`,
		);
	}
	if (!String(updateManifest.upgradeGuideUrl).endsWith("#guided-server-update")) {
		throw new Error(`Migration release guide URL is invalid: ${String(updateManifest.upgradeGuideUrl)}`);
	}

	testAutoR2BindingHelpers();
	cpSync(resolve(rootDir, "server"), repoDir, { recursive: true });

	run("git", ["init", "-q"]);
	run("git", ["config", "user.name", "KAOS Local Test"]);
	run("git", ["config", "user.email", "local-test@kaos"]);
	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", "baseline"]);

	const baselineVersion = read("src/version.ts");
	const baselineWrangler = read("wrangler.toml");
	const managedWorkflowPath = ".github/workflows/kaos-ops-v3.yml";
	const baselineManagedWorkflow = read(managedWorkflowPath);
	const customWorkflowPath = ".github/workflows/local-user-workflow.yml";
	const customWorkflow = "name: Local user workflow\n";
	writeFileSync(join(repoDir, managedWorkflowPath), `${baselineManagedWorkflow}\n# stale local copy\n`);
	writeFileSync(join(repoDir, customWorkflowPath), customWorkflow);
	const currentServerVersionMatch = baselineVersion.match(/SERVER_VERSION = "([^"]+)"/);
	if (!currentServerVersionMatch) {
		throw new Error("Unable to read current server version from src/version.ts");
	}
	const currentServerVersion = currentServerVersionMatch[1];
	const currentMinSchemaVersion = readRequiredNumberConst(baselineVersion, "SERVER_MIN_SCHEMA_VERSION");
	const currentMaxSchemaVersion = readRequiredNumberConst(baselineVersion, "SERVER_MAX_SCHEMA_VERSION");

	writeFileSync(
		join(repoDir, "src/version.ts"),
		baselineVersion
			.replace(
				`SERVER_VERSION = "${currentServerVersion}"`,
				'SERVER_VERSION = "0.1.9"',
			)
			.replace(
				/SERVER_MAX_SCHEMA_VERSION\s*=\s*\d+/,
				`SERVER_MAX_SCHEMA_VERSION = ${currentMinSchemaVersion}`,
			),
	);
	writeFileSync(join(repoDir, "wrangler.toml"), `${baselineWrangler}\n# local-test-preserved\n`);
	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", "simulate older deployed server"]);

	const migrationGuardOutput = runExpectFailure("node", ["scripts/update-from-release.mjs"], {
		env: {
			...process.env,
			KAOS_RELEASE_FILE: artifactPath,
		},
	});
	if (!migrationGuardOutput.includes("migration-required")) {
		throw new Error(`Expected migration-required update guard, got:\n${migrationGuardOutput}`);
	}
	const afterMigrationGuardVersion = read("src/version.ts");
	if (!afterMigrationGuardVersion.includes('SERVER_VERSION = "0.1.9"')) {
		throw new Error("Migration guard test failed: rejected update still modified src/version.ts");
	}

	run("node", ["scripts/update-from-release.mjs"], {
		env: {
			...process.env,
			KAOS_RELEASE_FILE: artifactPath,
			KAOS_ALLOW_MIGRATION_UPDATE: "true",
		},
	});

	const updatedVersion = read("src/version.ts");
	if (updatedVersion !== baselineVersion) {
		throw new Error("Update test failed: src/version.ts was not restored from the artifact");
	}

	const updatedWrangler = read("wrangler.toml");
	if (!updatedWrangler.includes("# local-test-preserved")) {
		throw new Error("Update test failed: protected wrangler.toml changes were overwritten");
	}
	if (read(managedWorkflowPath) !== `${baselineManagedWorkflow}\n# stale local copy\n`) {
		throw new Error("Update test failed: the immutable versioned bootstrap workflow was unexpectedly overwritten");
	}
	if (read(customWorkflowPath) !== customWorkflow) {
		throw new Error("Update test failed: a user-owned workflow was overwritten");
	}

	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", `kaos(server): update to ${currentServerVersion}`]);
	run("node", ["scripts/revert-last-update.mjs"]);

	const revertedVersion = read("src/version.ts");
	if (!revertedVersion.includes('SERVER_VERSION = "0.1.9"')) {
		throw new Error("Revert test failed: update-owned files were not restored");
	}

	const revertedWrangler = read("wrangler.toml");
	if (!revertedWrangler.includes("# local-test-preserved")) {
		throw new Error("Revert test failed: protected wrangler.toml changes were lost");
	}

	const badArtifactPath = buildBadSchemaArtifact(baselineVersion, currentMaxSchemaVersion + 100);
	const badUpdateOutput = runExpectFailure("node", ["scripts/update-from-release.mjs"], {
		env: {
			...process.env,
			KAOS_RELEASE_FILE: badArtifactPath,
		},
	});
	if (!badUpdateOutput.includes("schema compatibility gap")) {
		throw new Error(`Expected schema gap rejection, got:\n${badUpdateOutput}`);
	}
	const afterBadUpdateVersion = read("src/version.ts");
	if (!afterBadUpdateVersion.includes('SERVER_VERSION = "0.1.9"')) {
		throw new Error("Schema gap test failed: rejected update still modified src/version.ts");
	}

	// The v3 workflow extracts this updater from the release archive when a
	// detached deployment predates scripts/update-from-release.mjs. Such a
	// deployment can also predate src/version.ts, so the updater must still be
	// able to install its first versioned release after explicit migration consent.
	const legacyRepoDir = join(tempDir, "legacy-repo");
	mkdirSync(join(legacyRepoDir, "src"), { recursive: true });
	writeFileSync(
		join(legacyRepoDir, "package.json"),
		`${JSON.stringify({ name: "yaos-server", version: "0.1.0" }, null, 2)}\n`,
	);
	writeFileSync(
		join(legacyRepoDir, "wrangler.toml"),
		'name = "legacy-kaos"\nmain = "src/index.ts"\n',
	);
	writeFileSync(join(legacyRepoDir, "src/index.ts"), "export default {};\n");
	execFileSync("node", [resolve(rootDir, "server/scripts/update-from-release.mjs")], {
		cwd: legacyRepoDir,
		stdio: "inherit",
		env: {
			...process.env,
			KAOS_RELEASE_FILE: artifactPath,
			KAOS_ALLOW_MIGRATION_UPDATE: "true",
		},
	});
	const bootstrappedVersion = readFileSync(join(legacyRepoDir, "src/version.ts"), "utf8");
	if (bootstrappedVersion !== baselineVersion) {
		throw new Error("Legacy bootstrap update failed to install src/version.ts from the artifact");
	}
	const bootstrappedWorkflowPath = join(legacyRepoDir, managedWorkflowPath);
	if (!existsSync(bootstrappedWorkflowPath) || readFileSync(bootstrappedWorkflowPath, "utf8") !== baselineManagedWorkflow) {
		throw new Error("Legacy bootstrap update failed to install the managed updater workflow");
	}

	const vaultDir = join(tempDir, "vault");
	cpSync(resolve(rootDir, "server"), vaultDir, { recursive: true });
	mkdirSync(join(vaultDir, ".obsidian"), { recursive: true });
	const vaultGuardOutput = runExpectFailure("node", ["scripts/update-from-release.mjs"], {
		cwd: vaultDir,
		env: {
			...process.env,
			KAOS_RELEASE_FILE: artifactPath,
		},
	});
	if (!vaultGuardOutput.includes("Refusing to apply a KAOS server update inside an Obsidian vault")) {
		throw new Error(`Expected Obsidian vault guard rejection, got:\n${vaultGuardOutput}`);
	}
	const vaultRevertGuardOutput = runExpectFailure("node", ["scripts/revert-last-update.mjs"], {
		cwd: vaultDir,
	});
	if (!vaultRevertGuardOutput.includes("Refusing to revert a KAOS server update inside an Obsidian vault")) {
		throw new Error(`Expected Obsidian vault revert guard rejection, got:\n${vaultRevertGuardOutput}`);
	}

	const notServerDir = join(tempDir, "not-server");
	mkdirSync(notServerDir, { recursive: true });
	writeFileSync(join(notServerDir, "package.json"), `${JSON.stringify({ name: "not-kaos-server" }, null, 2)}\n`);
	const repoGuardOutput = runExpectFailure("node", [resolve(rootDir, "server/scripts/update-from-release.mjs")], {
		cwd: notServerDir,
		env: {
			...process.env,
			KAOS_RELEASE_FILE: artifactPath,
		},
	});
	if (!repoGuardOutput.includes("Refusing to apply a KAOS server update outside a KAOS server repository")) {
		throw new Error(`Expected server repo guard rejection, got:\n${repoGuardOutput}`);
	}

	console.log("Local KAOS server update/revert smoke test passed.");
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
