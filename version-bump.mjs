import { readFileSync, writeFileSync } from "node:fs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const INCREMENTS = new Set(["major", "minor", "patch"]);

function fail(message) {
	throw new Error(message);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function requireSemver(value, label) {
	if (typeof value !== "string" || !SEMVER.test(value)) {
		fail(`${label} must be a plain MAJOR.MINOR.PATCH version, received ${JSON.stringify(value)}`);
	}
	return value;
}

function resolveVersion(current, requested, label) {
	requireSemver(current, `${label} current version`);
	let target;

	if (!INCREMENTS.has(requested)) {
		target = requireSemver(requested, `${label} target version`);
	} else {
		const parts = current.split(".").map(Number);
		if (requested === "major") target = `${parts[0] + 1}.0.0`;
		else if (requested === "minor") target = `${parts[0]}.${parts[1] + 1}.0`;
		else target = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
	}

	const currentParts = current.split(".").map(Number);
	const targetParts = target.split(".").map(Number);
	const isNewer = targetParts.some((part, index) =>
		part > currentParts[index]
		&& targetParts.slice(0, index).every((prefix, prefixIndex) => prefix === currentParts[prefixIndex]));
	if (!isNewer) fail(`${label} target version ${target} must be newer than ${current}`);
	return target;
}

function parseBumpArguments(args) {
	const plugin = args[0];
	if (!plugin || plugin.startsWith("--")) {
		fail("usage: npm run version:bump -- <patch|minor|major|VERSION> [--server <...>] [--headless <...>]");
	}

	const result = { plugin };
	for (let index = 1; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!value) fail(`${flag} requires a version or major/minor/patch`);
		if (flag === "--server") result.server = value;
		else if (flag === "--headless") result.headlessHost = value;
		else fail(`unknown option ${flag}`);
	}
	return result;
}

function loadState() {
	const rootPackage = readJson("package.json");
	const releaseVersions = rootPackage.releaseVersions;
	if (!releaseVersions || typeof releaseVersions !== "object") {
		fail("package.json must contain releaseVersions.server and releaseVersions.headlessHost");
	}

	return {
		rootPackage,
		rootLock: readJson("package-lock.json"),
		manifest: readJson("manifest.json"),
		versions: readJson("versions.json"),
		headlessManifest: readJson("headless-host.version.json"),
		serverPackage: readJson("server/package.json"),
		serverLock: readJson("server/package-lock.json"),
		serverVersionSource: readFileSync("server/src/version.ts", "utf8"),
		canonical: {
			plugin: requireSemver(rootPackage.version, "package.json version"),
			server: requireSemver(releaseVersions.server, "package.json releaseVersions.server"),
			headlessHost: requireSemver(
				releaseVersions.headlessHost,
				"package.json releaseVersions.headlessHost",
			),
		},
	};
}

function expectedState(state, canonical) {
	const rootPackage = structuredClone(state.rootPackage);
	rootPackage.version = canonical.plugin;
	rootPackage.releaseVersions.server = canonical.server;
	rootPackage.releaseVersions.headlessHost = canonical.headlessHost;

	const rootLock = structuredClone(state.rootLock);
	rootLock.version = canonical.plugin;
	if (!rootLock.packages?.[""]) fail("package-lock.json is missing packages[\"\"]");
	rootLock.packages[""].version = canonical.plugin;

	const manifest = structuredClone(state.manifest);
	manifest.version = canonical.plugin;
	if (typeof manifest.minAppVersion !== "string" || !manifest.minAppVersion) {
		fail("manifest.json is missing minAppVersion");
	}

	const versions = structuredClone(state.versions);
	versions[canonical.plugin] = manifest.minAppVersion;

	const headlessManifest = structuredClone(state.headlessManifest);
	headlessManifest.version = canonical.headlessHost;

	const serverPackage = structuredClone(state.serverPackage);
	serverPackage.version = canonical.server;

	const serverLock = structuredClone(state.serverLock);
	serverLock.version = canonical.server;
	if (!serverLock.packages?.[""]) fail("server/package-lock.json is missing packages[\"\"]");
	serverLock.packages[""].version = canonical.server;

	const serverVersionPattern = /export const SERVER_VERSION = "[^"]+";/;
	if (!serverVersionPattern.test(state.serverVersionSource)) {
		fail("server/src/version.ts is missing SERVER_VERSION");
	}
	const serverVersionSource = state.serverVersionSource.replace(
		serverVersionPattern,
		`export const SERVER_VERSION = "${canonical.server}";`,
	);

	return {
		rootPackage,
		rootLock,
		manifest,
		versions,
		headlessManifest,
		serverPackage,
		serverLock,
		serverVersionSource,
	};
}

function serializeJson(value) {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function check(state, expected) {
	const mismatches = [];
	const compareJson = (path, actual, wanted) => {
		if (serializeJson(actual) !== serializeJson(wanted)) mismatches.push(path);
	};

	compareJson("package.json", state.rootPackage, expected.rootPackage);
	compareJson("package-lock.json", state.rootLock, expected.rootLock);
	compareJson("manifest.json", state.manifest, expected.manifest);
	compareJson("versions.json", state.versions, expected.versions);
	compareJson("headless-host.version.json", state.headlessManifest, expected.headlessManifest);
	compareJson("server/package.json", state.serverPackage, expected.serverPackage);
	compareJson("server/package-lock.json", state.serverLock, expected.serverLock);
	if (state.serverVersionSource !== expected.serverVersionSource) mismatches.push("server/src/version.ts");

	if (mismatches.length) {
		fail(`version metadata is out of sync: ${mismatches.join(", ")}\nRun npm run version:sync`);
	}

	console.log(
		`Version metadata is synchronized (plugin ${state.canonical.plugin}, server ${state.canonical.server}, headless ${state.canonical.headlessHost}).`,
	);
}

function writeExpected(expected) {
	writeJson("package.json", expected.rootPackage);
	writeJson("package-lock.json", expected.rootLock);
	writeJson("manifest.json", expected.manifest);
	writeJson("versions.json", expected.versions);
	writeJson("headless-host.version.json", expected.headlessManifest);
	writeJson("server/package.json", expected.serverPackage);
	writeJson("server/package-lock.json", expected.serverLock);
	writeFileSync("server/src/version.ts", expected.serverVersionSource);
}

const args = process.argv.slice(2);
const state = loadState();

if (args.length === 1 && args[0] === "--check") {
	check(state, expectedState(state, state.canonical));
} else if (args.length === 1 && args[0] === "--sync") {
	writeExpected(expectedState(state, state.canonical));
	const updated = loadState();
	check(updated, expectedState(updated, state.canonical));
} else {
	const requested = parseBumpArguments(args);
	const canonical = {
		plugin: resolveVersion(state.canonical.plugin, requested.plugin, "plugin"),
		server: requested.server
			? resolveVersion(state.canonical.server, requested.server, "server")
			: state.canonical.server,
		headlessHost: requested.headlessHost
			? resolveVersion(state.canonical.headlessHost, requested.headlessHost, "headless host")
			: state.canonical.headlessHost,
	};

	writeExpected(expectedState(state, canonical));
	const updated = loadState();
	check(updated, expectedState(updated, canonical));
	console.log(
		`Bumped plugin ${state.canonical.plugin} -> ${canonical.plugin}`
			+ (requested.server ? `, server ${state.canonical.server} -> ${canonical.server}` : "")
			+ (requested.headlessHost
				? `, headless ${state.canonical.headlessHost} -> ${canonical.headlessHost}`
				: ""),
	);
}
