#!/usr/bin/env node
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import esbuild from "esbuild";
import { zipSync } from "fflate";

const obsidianShim = resolve("src/headless-host/obsidianShim.ts");
const outfile = "dist/kaos-headless-host.mjs";
const kaosctlOutfile = "dist/kaosctl.mjs";
const manifestOutfile = "dist/kaos-headless-host-manifest.json";
const oracleBundleOutfile = "dist/kaos-headless-host-oracle.zip";
const userManifestOutfile = "dist/kaos-headless-user-manifest.json";
const userBundleOutfile = "dist/kaos-headless-user.zip";
const pluginBundleOutfile = "dist/kaos-plugin.zip";
const buildLockDir = "dist/.kaos-headless-host-build.lock";
const pluginFiles = ["manifest.json", "main.js", "telemetry.js", "styles.css"];
const releaseAssets = [
	outfile,
	`${outfile}.sha256`,
	"deploy/kaos-headless-host.service",
	"deploy/oracle-acceptance-config.example.json",
	"scripts/bootstrap-headless-host-oracle.mjs",
	"scripts/install-headless-host.mjs",
	"scripts/uninstall-headless-host.mjs",
	"scripts/update-headless-host-from-release.mjs",
	"scripts/verify-headless-host-bundle.mjs",
	"scripts/validate-headless-host-release-assets.mjs",
	"scripts/run-headless-host-oracle-rehearsal.mjs",
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"scripts/run-headless-host-oracle-acceptance.mjs",
	"scripts/verify-headless-host-oracle-acceptance.mjs",
	"scripts/verify-headless-host-oracle-rehearsal.mjs",
	"scripts/smoke-headless-host-sync.mjs",
	"scripts/postflight-headless-host.mjs",
	"scripts/rollback-headless-host.mjs",
	pluginBundleOutfile,
];

const obsidianAliasPlugin = {
	name: "kaos-headless-host-obsidian-alias",
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({
			path: obsidianShim,
		}));
	},
};

await mkdir("dist", { recursive: true });
await acquireBuildLock(buildLockDir);
let buildLockReleased = false;
process.once("exit", releaseBuildLock);

await esbuild.build({
	entryPoints: ["src/headless-host/cli.ts"],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node18",
	sourcemap: true,
	logLevel: "info",
	plugins: [obsidianAliasPlugin],
	define: {
		__KAOS_QA_HARNESS_ENABLED__: "false",
	},
	external: [
		"electron",
		...builtinModules,
		...builtinModules.map((name) => `node:${name}`),
	],
	banner: {
		js: `#!/usr/bin/env node
import { createRequire as __kaosCreateRequire } from "node:module";
const require = __kaosCreateRequire(import.meta.url);`,
	},
});

await esbuild.build({
	entryPoints: ["scripts/kaosctl.mjs"],
	outfile: kaosctlOutfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	sourcemap: false,
	logLevel: "info",
	external: [
		...builtinModules,
		...builtinModules.map((name) => `node:${name}`),
	],
});
await chmod(kaosctlOutfile, 0o755);
const kaosctlArtifact = await readFile(kaosctlOutfile);
const uninstallerArtifact = await readFile("scripts/uninstall-headless-host.mjs");
await writeFile("dist/uninstall-headless-host.mjs", uninstallerArtifact);
await chmod("dist/uninstall-headless-host.mjs", 0o755);
await writeFile(`${kaosctlOutfile}.sha256`, `${sha256Bytes(kaosctlArtifact)}  kaosctl.mjs\n`, "utf8");

const artifact = await readFile(outfile);
const sha256 = sha256Bytes(artifact);
await writeFile(`${outfile}.sha256`, `${sha256}  kaos-headless-host.mjs\n`, "utf8");
await chmod(outfile, 0o755);
const pluginBundle = await buildPluginBundle(pluginBundleOutfile);
const rootManifest = JSON.parse(await readFile("manifest.json", "utf8"));
const headlessVersionManifest = JSON.parse(await readFile("headless-host.version.json", "utf8"));
const pluginVersion = rootManifest.version;
const headlessVersion = headlessVersionManifest.version;
if (typeof pluginVersion !== "string" || pluginVersion.length === 0) {
	throw new Error("manifest.json is missing version");
}
if (!isSemver(headlessVersion)) {
	throw new Error("headless-host.version.json must contain a semver version");
}

const manifestAssets = {};
for (const assetPath of releaseAssets) {
	const bytes = await readFile(assetPath);
	const info = await stat(assetPath);
	manifestAssets[assetPath.split("/").pop()] = {
		sha256: sha256Bytes(bytes),
		bytes: info.size,
	};
}
await writeFile(manifestOutfile, `${JSON.stringify({
	kind: "kaos-headless-host-release-manifest",
	schemaVersion: 1,
	version: headlessVersion,
	pluginVersion,
	runtime: "kaos-headless-host",
	assets: manifestAssets,
}, null, 2)}\n`, "utf8");

const bundleEntries = {};
const bundleAssets = {};
for (const assetPath of [...releaseAssets, manifestOutfile]) {
	const bytes = await readFile(assetPath);
	const name = assetPath.split("/").pop();
	bundleEntries[name] = bytes;
	bundleAssets[name] = {
		sha256: sha256Bytes(bytes),
		bytes: bytes.length,
		source: assetPath,
	};
}
const readme = Buffer.from(`KAOS Headless Host Oracle bundle

This bundle contains the headless host binary, checksum, release manifest,
systemd service template, and bootstrap/install/uninstall/update/verify/local+remote rehearsal/smoke/postflight/rollback helpers.

For the safest real-VM acceptance run from a local release directory, use
run-headless-host-oracle-acceptance.mjs next to this zip and checksum. It wraps
the phase runner into preflight, install, structured reboot, post-reboot
verification, and update verification. For lower-level SSH/SCP driven Oracle
rehearsals, use run-headless-host-oracle-remote-rehearsal.mjs directly.
When running outside the repo root, pass --skip-local-prepare together with
explicit --zip and --checksum paths; the VM still verifies sha256 and the
unpacked bundle before install/update. As a shorter form, pass --release-dir .
from a directory containing the zip, checksum, and helper scripts. The remote post-reboot phase uses the
installed /opt/kaos/run-headless-host-oracle-rehearsal.mjs by default, so it
does not depend on the temporary unpacked bundle surviving reboot.

Minimum Oracle VM bootstrap:

  sudo node bootstrap-headless-host-oracle.mjs \\
    --host https://YOUR_WORKER_HOST \\
    --vault-id YOUR_VAULT_ID \\
    --device-name server-headless

This creates the kaos service group/user, /opt/kaos, /srv/kaos/vault,
/var/lib/kaos-headless, and /etc/kaos/headless.env. The environment file is
root:kaos 0640; the service state directory is kaos:kaos 0700. No shared
credential is written. The service identity is created only by the service
account during the enrollment command below.
The headless host binary is only the runner. It loads the KAOS Obsidian plugin
from the configured vault, by default /srv/kaos/vault/.obsidian/plugins/kaos.
Install or sync the plugin into that vault before starting the service; the
service doctor checks manifest.json and main.js there. Release updates keep
that plugin in step with the runner while preserving its data.json settings.
The bundled systemd service uses /usr/bin/node -- /opt/kaos/kaos-headless-host.mjs
so headless host flags are not parsed as Node.js options. If you change the
bootstrap user or paths, update User=/Group=, ExecStart/ExecStartPre, and
WorkingDirectory/ReadWritePaths in kaos-headless-host.service to match before
running postflight.
If Node is installed somewhere else on the VM, pass --service-node "$(command -v node)"
to update-headless-host-from-release.mjs so the installed service uses that binary.

Offline install/update example from this unpacked directory:

  node validate-headless-host-release-assets.mjs \\
    --zip ../kaos-headless-host-oracle.zip \\
    --checksum ../kaos-headless-host-oracle.zip.sha256

  node verify-headless-host-bundle.mjs --bundle-dir .

  sudo node update-headless-host-from-release.mjs \\
    --bundle-dir . \\
    --install-dir /opt/kaos \\
    --service-path /etc/systemd/system/kaos-headless-host.service \\
    --postflight \\
    --postflight-smoke-work-dir /var/lib/kaos-headless/smoke-work \\
    --rollback-on-postflight-failure \\
    --enable-service

The update wrapper also runs the same bundle verification automatically whenever
--bundle-dir is used. Keep the explicit command above as a visible pre-install
gate when operating by hand.

For a logged first-install rehearsal, create a one-time Owner invitation in the
KAOS settings UI, run the install phase, compare its displayed fingerprint,
approve it as Owner, then activate and reboot:

  node run-headless-host-oracle-rehearsal.mjs \\
    --phase install \\
    --bundle-dir . \\
    --host https://YOUR_WORKER_HOST \\
    --vault-id YOUR_VAULT_ID \\
    --device-name server-headless \\
    --invite-file /secure/local/path/to/device-enroll.invite \\
    --log-dir "$HOME/kaos-headless-rehearsal"

  # Compare and approve the pending device in the Owner UI, then:
  sudo node run-headless-host-oracle-rehearsal.mjs \\
    --phase activate \\
    --confirm-owner-approved \\
    --log-dir "$HOME/kaos-headless-rehearsal"

  sudo reboot

  sudo node /opt/kaos/run-headless-host-oracle-rehearsal.mjs \\
    --phase post-reboot \\
    --log-dir "$HOME/kaos-headless-rehearsal"

Postflight verifies the binary, metadata, systemd service paths, service user
identity/access, strict doctor, systemctl restart/is-active, and primary<->peer
Markdown sync smoke. On postflight failure, --rollback-on-postflight-failure
restores the previous binary/service/helpers/metadata and verifies recovery.
The sync smoke uses --require-lock and validates that the primary lock describes
a running kaos-headless-host for the same vault/data file before writing smoke
notes. By default it removes the generated smoke files and empty KAOS smoke
directories; use --keep-files only when preserving smoke artifacts for failure
analysis.
With --no-helper-scripts, the update wrapper does not install helpers under
--install-dir and instead resolves postflight/smoke/rollback helpers next to
the running update wrapper.
If the service user cannot write to the system temp directory, pass
--postflight-smoke-work-dir with a writable path such as
/var/lib/kaos-headless/smoke-work. Keep this path outside the primary vault;
postflight and smoke preflight reject peer workspaces that overlap the primary
vault.

--enable-service also verifies systemctl is-enabled --quiet after enabling the unit.
If you did not pass --enable-service, enable boot start after postflight succeeds:

  sudo systemctl enable kaos-headless-host

To install and run pre-restart checks without systemctl restart or smoke:

  sudo node update-headless-host-from-release.mjs \\
    --bundle-dir . \\
    --install-dir /opt/kaos \\
    --service-path /etc/systemd/system/kaos-headless-host.service \\
    --postflight \\
    --postflight-check-only

To check an already installed configuration without restart or smoke:

  sudo node /opt/kaos/postflight-headless-host.mjs \\
    --binary /opt/kaos/kaos-headless-host.mjs \\
    --vault /srv/kaos/vault \\
    --data-file /var/lib/kaos-headless/data.json \\
    --lock-file /run/kaos-headless/kaos.lock \\
    --env-file /etc/kaos/headless.env \\
    --identity-file /var/lib/kaos-headless/device-identity.json \\
    --check-only

After reboot, verify that the service is still enabled and came up without
masking boot behavior via restart:

When using the remote rehearsal wrapper after reboot, add --wait-for-ssh so the
wrapper polls SSH readiness before it runs post-reboot evidence capture. If the
wrapper requested the reboot, also add --require-reboot-request so fetched logs
must include 11-reboot-request.json and the verifier can confirm post-reboot
verification happened after the recorded reboot request. This keeps "VM is
still booting" separate from real postflight failures and keeps the reboot
request in the evidence set.
The acceptance wrapper does this full sequence and requires an explicit
--confirm-reboot before it schedules the reboot:

  node run-headless-host-oracle-acceptance.mjs \\
    --ssh-target opc@YOUR_ORACLE_VM \\
    --worker-host https://YOUR_WORKER_HOST \\
    --vault-id YOUR_VAULT_ID \\
    --invite-file /secure/local/path/to/device-enroll.invite \\
    --remote-dir kaos-headless-acceptance-YYYYMMDDTHHMMSSZ \\
    --evidence-root ./oracle-acceptance-logs \\
    --release-dir . \\
    --confirm-reboot

Equivalent explicit release-asset arguments are:
--skip-local-prepare --zip ./kaos-headless-host-oracle.zip --checksum ./kaos-headless-host-oracle.zip.sha256

To avoid rebuilding long commands by hand, store non-secret defaults in
acceptance-config.json. Keep the one-time invitation out of this file; point
inviteFile at a separate protected file. Choose --dry-run or --confirm-reboot on the command
line for each run, not in the config. This bundle includes
oracle-acceptance-config.example.json as a starting point:

  cp oracle-acceptance-config.example.json acceptance-config.json

  {
    "sshTarget": "opc@YOUR_ORACLE_VM",
    "remoteDir": "kaos-headless-acceptance-YYYYMMDDTHHMMSSZ",
    "workerHost": "https://YOUR_WORKER_HOST",
    "vaultId": "YOUR_VAULT_ID",
    "deviceName": "server-headless",
    "inviteFile": "/secure/local/path/to/device-enroll.invite",
    "evidenceRoot": "./oracle-acceptance-logs",
    "releaseDir": "."
  }

  node run-headless-host-oracle-acceptance.mjs \\
    --config ./acceptance-config.json \\
    --validate-local

--validate-local checks config placeholders such as YOUR_* and YYYYMMDD*,
protected invitation-file permissions, release zip/checksum integrity, required local helpers, and
local bundle verification by temporarily extracting the release zip and running
verify-headless-host-bundle.mjs without running ssh/scp or writing evidence.

  node run-headless-host-oracle-acceptance.mjs \\
    --config ./acceptance-config.json \\
    --dry-run

  node run-headless-host-oracle-acceptance.mjs \\
    --config ./acceptance-config.json \\
    --confirm-reboot

The acceptance JSON includes evidenceDirs and nextStep. Keep --update-remote-dir
different from --remote-dir so update evidence does not overwrite the
install/reboot/post-reboot evidence set. A non-dry-run acceptance writes the
same redacted result to <evidence-root>/acceptance-summary.json by default; pass
--summary-file to choose a different path.
If the local shell disconnects after a phase completes, resume from that saved
summary instead of rebuilding the command by hand. The wrapper infers the next
phase, reuses the recorded ssh target and evidence directories, and merges
earlier successful phase results into the final summary:

  node run-headless-host-oracle-acceptance.mjs \\
    --resume-from-summary ./oracle-acceptance-logs/acceptance-summary.json \\
    --confirm-owner-approved \\
    --release-dir . \\
    --confirm-reboot

To re-check a copied evidence root later:

  node verify-headless-host-oracle-acceptance.mjs \\
    --summary-file ./oracle-acceptance-logs/acceptance-summary.json \\
    --require-full

Before scheduling reboot, rerun the same command with --dry-run. Dry-run prints
the phase plan without running ssh/scp, creating evidence directories, or
requiring --confirm-reboot.
The same wrapper can request the reboot in a structured phase:

  node run-headless-host-oracle-remote-rehearsal.mjs \\
    --phase reboot \\
    --ssh-target opc@YOUR_ORACLE_VM \\
    --remote-dir kaos-headless-rehearsal-YYYYMMDDTHHMMSSZ

You can reuse the installed update wrapper to run the verification postflight
without downloading or reinstalling anything. Do not combine --postflight-only
with release source or install-only options such as --base-url, --bundle-dir,
--repo, or --service-node. Failed checks keep mode=postflight-only and the child
postflight diagnostics in JSON:

  sudo node /opt/kaos/update-headless-host-from-release.mjs \\
    --postflight-only \\
    --install-dir /opt/kaos \\
    --service-path /etc/systemd/system/kaos-headless-host.service \\
    --postflight-verify-running \\
    --postflight-smoke-work-dir /var/lib/kaos-headless/smoke-work

Or run postflight directly, which is the simplest post-reboot check:

  sudo node /opt/kaos/postflight-headless-host.mjs \\
    --binary /opt/kaos/kaos-headless-host.mjs \\
    --vault /srv/kaos/vault \\
    --data-file /var/lib/kaos-headless/data.json \\
    --lock-file /run/kaos-headless/kaos.lock \\
    --env-file /etc/kaos/headless.env \\
    --identity-file /var/lib/kaos-headless/device-identity.json \\
    --smoke-script /opt/kaos/smoke-headless-host-sync.mjs \\
    --smoke-work-dir /var/lib/kaos-headless/smoke-work \\
    --verify-running

For a lower-level install before enrollment and Owner approval are complete,
omit postflight:

  sudo node update-headless-host-from-release.mjs \\
    --bundle-dir . \\
    --install-dir /opt/kaos \\
    --service-path /etc/systemd/system/kaos-headless-host.service

To remove the system installation while preserving the vault:

  sudo node /opt/kaos/uninstall-headless-host.mjs --yes

Add --purge-vault only when /srv/kaos/vault should also be deleted. Removing
the dedicated service account additionally requires --remove-user; use
--remove-group as well only when the kaos group is no longer shared.
`, "utf8");
bundleEntries["README-headless-host.txt"] = readme;
bundleAssets["README-headless-host.txt"] = {
	sha256: sha256Bytes(readme),
	bytes: readme.length,
	source: "generated",
};
bundleEntries["kaos-headless-host-bundle-manifest.json"] = Buffer.from(`${JSON.stringify({
	kind: "kaos-headless-host-oracle-bundle",
	schemaVersion: 1,
	version: headlessVersion,
	pluginVersion,
	runtime: "kaos-headless-host",
	assets: bundleAssets,
}, null, 2)}\n`, "utf8");
const bundle = zipSync(bundleEntries, { level: 9 });
await writeFile(oracleBundleOutfile, bundle);
await writeFile(`${oracleBundleOutfile}.sha256`, `${sha256Bytes(bundle)}  kaos-headless-host-oracle.zip\n`, "utf8");

const userBundleEntries = {
	"kaos-headless-host.mjs": artifact,
	"kaosctl.mjs": kaosctlArtifact,
	"uninstall-headless-host.mjs": uninstallerArtifact,
	"kaos-plugin.zip": pluginBundle,
	"VERSION": Buffer.from(`${headlessVersion}\n`, "utf8"),
	"kaos-headless-host.user.service": await readFile("deploy/kaos-headless-host.user.service"),
};
const userReadme = Buffer.from(`KAOS Headless User bundle

This bundle is installed by scripts/install.sh and maintained by the kaos CLI.
The installer is intentionally interactive. Service startup runs:

  kaos update --startup

Updates are non-interactive, verify the newly installed runner with doctor,
and roll back the current symlink if verification fails. Updates also replace
the KAOS runtime files in the configured vault from the verified release bundle,
while preserving its data.json settings.

Control the installed user service with:

  kaos start
  kaos stop

Remove the user service, runner, state, and sync configuration with:

  kaos uninstall --yes

The vault is preserved. Add --purge-vault --vault /path/to/vault only when the
vault itself should be deleted.

Install from the public release with:

  curl -fsSL https://raw.githubusercontent.com/adtstack/kaos/main/scripts/install.sh | bash

`, "utf8");
userBundleEntries["README-headless-user.txt"] = userReadme;
const userBundleAssets = {};
for (const [name, bytes] of Object.entries(userBundleEntries)) {
	userBundleAssets[name] = {
		sha256: sha256Bytes(bytes),
		bytes: bytes.length,
	};
}
userBundleEntries["kaos-headless-user-bundle-manifest.json"] = Buffer.from(`${JSON.stringify({
	kind: "kaos-headless-user-bundle",
	schemaVersion: 1,
	version: headlessVersion,
	pluginVersion,
	assets: userBundleAssets,
}, null, 2)}\n`, "utf8");
const userBundle = zipSync(userBundleEntries, { level: 9 });
await writeFile(userBundleOutfile, userBundle);
await writeFile(`${userBundleOutfile}.sha256`, `${sha256Bytes(userBundle)}  kaos-headless-user.zip\n`, "utf8");
await writeUserReleaseManifest({ headlessVersion, pluginVersion });
releaseBuildLock();

async function acquireBuildLock(dir) {
	const started = Date.now();
	while (true) {
		try {
			await mkdir(dir);
			await writeFile(`${dir}/owner.json`, `${JSON.stringify({
				pid: process.pid,
				startedAt: new Date().toISOString(),
			}, null, 2)}\n`, "utf8");
			return;
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
			if (Date.now() - started > 120_000) {
				throw new Error(`timed out waiting for headless host build lock: ${dir}`);
			}
			await sleep(250);
		}
	}
}

function releaseBuildLock() {
	if (buildLockReleased) return;
	buildLockReleased = true;
	rmSync(buildLockDir, { recursive: true, force: true });
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function isSemver(value) {
	return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

async function buildPluginBundle(outPath) {
	const entries = {};
	for (const file of pluginFiles) {
		entries[file] = await readFile(file);
	}
	const pluginBundleBytes = zipSync(entries, { level: 9 });
	await writeFile(outPath, pluginBundleBytes);
	await writeFile(`${outPath}.sha256`, `${sha256Bytes(pluginBundleBytes)}  kaos-plugin.zip\n`, "utf8");
	return pluginBundleBytes;
}

async function writeUserReleaseManifest({ headlessVersion, pluginVersion }) {
	const assetPaths = [kaosctlOutfile, userBundleOutfile, pluginBundleOutfile];
	const assets = {};
	for (const assetPath of assetPaths) {
		const bytes = await readFile(assetPath);
		assets[assetPath.split("/").pop()] = {
			sha256: sha256Bytes(bytes),
			bytes: bytes.length,
		};
	}
	await writeFile(userManifestOutfile, `${JSON.stringify({
		kind: "kaos-headless-user-release-manifest",
		schemaVersion: 1,
		version: headlessVersion,
		pluginVersion,
		runtime: "kaos-headless-host",
		assets,
	}, null, 2)}\n`, "utf8");
}
