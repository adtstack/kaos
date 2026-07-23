import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary = await mkdtemp(join(tmpdir(), "kaos-version-bump-"));

function json(value) {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

async function writeJson(path, value) {
	await writeFile(join(temporary, path), json(value));
}

async function readJson(path) {
	return JSON.parse(await readFile(join(temporary, path), "utf8"));
}

function run(args, expectedStatus = 0) {
	const result = spawnSync(process.execPath, ["version-bump.mjs", ...args], {
		cwd: temporary,
		encoding: "utf8",
	});
	assert.equal(
		result.status,
		expectedStatus,
		`version-bump ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
	);
	return `${result.stdout}${result.stderr}`;
}

try {
	await mkdir(join(temporary, "server/src"), { recursive: true });
	await copyFile("version-bump.mjs", join(temporary, "version-bump.mjs"));
	await writeJson("package.json", {
		name: "fixture",
		version: "1.2.3",
		releaseVersions: { server: "4.5.6", headlessHost: "7.8.9" },
	});
	await writeJson("package-lock.json", {
		name: "fixture",
		version: "1.2.3",
		lockfileVersion: 3,
		packages: { "": { name: "fixture", version: "1.2.3" } },
	});
	await writeJson("manifest.json", {
		id: "fixture",
		version: "1.2.3",
		minAppVersion: "1.5.0",
	});
	await writeJson("versions.json", { "1.2.3": "1.5.0" });
	await writeJson("headless-host.version.json", { version: "7.8.9" });
	await writeJson("server/package.json", { name: "fixture-server", version: "4.5.6" });
	await writeJson("server/package-lock.json", {
		name: "fixture-server",
		version: "4.5.6",
		lockfileVersion: 3,
		packages: { "": { name: "fixture-server", version: "4.5.6" } },
	});
	await writeFile(
		join(temporary, "server/src/version.ts"),
		'export const SERVER_VERSION = "4.5.6";\nexport const UNRELATED = "keep-me";\n',
	);

	run(["--check"]);
	run(["patch", "--server", "minor", "--headless", "8.0.0"]);

	const rootPackage = await readJson("package.json");
	assert.equal(rootPackage.version, "1.2.4");
	assert.deepEqual(rootPackage.releaseVersions, { server: "4.6.0", headlessHost: "8.0.0" });
	assert.equal((await readJson("package-lock.json")).packages[""].version, "1.2.4");
	assert.equal((await readJson("manifest.json")).version, "1.2.4");
	assert.equal((await readJson("versions.json"))["1.2.4"], "1.5.0");
	assert.equal((await readJson("headless-host.version.json")).version, "8.0.0");
	assert.equal((await readJson("server/package.json")).version, "4.6.0");
	assert.equal((await readJson("server/package-lock.json")).packages[""].version, "4.6.0");
	assert.match(await readFile(join(temporary, "server/src/version.ts"), "utf8"), /4\.6\.0/);
	assert.match(await readFile(join(temporary, "server/src/version.ts"), "utf8"), /keep-me/);

	const manifest = await readJson("manifest.json");
	manifest.version = "9.9.9";
	await writeJson("manifest.json", manifest);
	assert.match(run(["--check"], 1), /manifest\.json/);
	run(["--sync"]);
	assert.equal((await readJson("manifest.json")).version, "1.2.4");

	const manuallyEditedPackage = await readJson("package.json");
	manuallyEditedPackage.version = "1.3.0";
	manuallyEditedPackage.releaseVersions = { server: "5.0.0", headlessHost: "8.0.1" };
	await writeJson("package.json", manuallyEditedPackage);
	run(["--sync"]);
	assert.equal((await readJson("manifest.json")).version, "1.3.0");
	assert.equal((await readJson("package-lock.json")).version, "1.3.0");
	assert.equal((await readJson("server/package.json")).version, "5.0.0");
	assert.equal((await readJson("headless-host.version.json")).version, "8.0.1");
	assert.equal((await readJson("versions.json"))["1.3.0"], "1.5.0");

	assert.match(run(["1.3.0"], 1), /must be newer/);
	assert.equal((await readJson("package.json")).version, "1.3.0");

	console.log("Version bump tests passed");
} finally {
	await rm(temporary, { recursive: true, force: true });
}
