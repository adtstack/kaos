import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(".");

function assertSafeServerRepoTarget() {
	if (existsSync(join(repoRoot, ".obsidian"))) {
		throw new Error(
			[
				"Refusing to revert a KAOS server update inside an Obsidian vault.",
				`Current directory: ${repoRoot}`,
				"Run this command from the generated Cloudflare Worker/server repository instead, not from your note vault.",
			].join(" "),
		);
	}
	const packagePath = join(repoRoot, "package.json");
	if (!existsSync(packagePath)) {
		throw new Error(`Refusing to revert outside a KAOS server repository: missing ${packagePath}`);
	}
	const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
	if (packageJson?.name !== "kaos-server") {
		throw new Error(
			`Refusing to revert outside a KAOS server repository: package name is ${String(packageJson?.name ?? "missing")}`,
		);
	}
}

function read(command, args) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	}).trim();
}

assertSafeServerRepoTarget();

const lastUpdateCommit = read("git", [
	"log",
	"--fixed-strings",
	"--grep",
	"kaos(server): update to ",
	"-n",
	"1",
	"--format=%H",
]);

if (!lastUpdateCommit) {
	throw new Error("No previous KAOS server update commit was found");
}

console.log(`Reverting ${lastUpdateCommit}`);
execFileSync("git", ["revert", "--no-edit", lastUpdateCommit], {
	stdio: "inherit",
});
