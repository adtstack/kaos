import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BINDING_NAME = "KAOS_BUCKET";
const CONFIG_PATH = resolve("wrangler.toml");

function escapeTomlString(value) {
	return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function hasR2Binding(source, bindingName = DEFAULT_BINDING_NAME) {
	const blockRegex = /\[\[r2_buckets\]\]([\s\S]*?)(?=\n\[\[|\n\[|$)/g;
	let match;
	while ((match = blockRegex.exec(source)) !== null) {
		const bindingMatch = match[1].match(/^\s*binding\s*=\s*"([^"]+)"/m);
		if (bindingMatch?.[1]?.trim() === bindingName) {
			return true;
		}
	}
	return false;
}

export function readWorkerName(source) {
	for (const line of source.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[")) return null;
		const match = trimmed.match(/^name\s*=\s*"([^"]+)"/);
		if (match?.[1]) return match[1].trim();
	}
	return null;
}

export function appendR2Binding(source, bucketName, bindingName = DEFAULT_BINDING_NAME) {
	const normalized = source.endsWith("\n") ? source : `${source}\n`;
	return `${normalized}
# Auto-added during deploy when an existing KAOS R2 binding was detected.
[[r2_buckets]]
binding = "${escapeTomlString(bindingName)}"
bucket_name = "${escapeTomlString(bucketName)}"
`;
}

function parseJsonOutput(output) {
	const trimmed = output.trim();
	if (!trimmed) return null;
	for (const marker of ["{", "["]) {
		const start = trimmed.indexOf(marker);
		if (start < 0) continue;
		try {
			return JSON.parse(trimmed.slice(start));
		} catch {
			// Wrangler may print a banner before JSON; try the next marker.
		}
	}
	return null;
}

function visit(value, callback) {
	if (value === null || value === undefined) return;
	if (Array.isArray(value)) {
		for (const item of value) visit(item, callback);
		return;
	}
	if (typeof value !== "object") return;
	callback(value);
	for (const item of Object.values(value)) {
		visit(item, callback);
	}
}

export function extractVersionIds(payload) {
	const ids = [];
	const seen = new Set();
	visit(payload, (node) => {
		for (const [key, value] of Object.entries(node)) {
			if (typeof value !== "string") continue;
			if (!/^version[-_]?id$/i.test(key)) continue;
			if (seen.has(value)) continue;
			seen.add(value);
			ids.push(value);
		}
	});
	return ids;
}

export function extractR2BucketName(payload, bindingName = DEFAULT_BINDING_NAME) {
	let bucketName = null;
	visit(payload, (node) => {
		if (bucketName) return;
		const name = typeof node.name === "string" ? node.name : null;
		const binding = typeof node.binding === "string" ? node.binding : null;
		if (name !== bindingName && binding !== bindingName) return;
		const type = typeof node.type === "string" ? node.type.toLowerCase() : "";
		const hasR2Shape =
			type.includes("r2") ||
			"bucket_name" in node ||
			"bucketName" in node ||
			"bucket" in node;
		if (!hasR2Shape) return;
		const candidate = node.bucket_name ?? node.bucketName ?? node.bucket;
		if (typeof candidate === "string" && candidate.trim()) {
			bucketName = candidate.trim();
		}
	});
	return bucketName;
}

export function extractBucketNamesFromListOutput(output) {
	const payload = parseJsonOutput(output);
	if (payload) {
		const names = [];
		const seen = new Set();
		visit(payload, (node) => {
			const candidate = node.name ?? node.bucket_name ?? node.bucketName;
			if (typeof candidate !== "string") return;
			const name = candidate.trim();
			if (!name || seen.has(name)) return;
			seen.add(name);
			names.push(name);
		});
		return names;
	}

	const names = [];
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || /^[-\s|+]+$/.test(trimmed) || /^name\b/i.test(trimmed)) continue;
		const firstColumn = trimmed.split(/\s+/)[0]?.replace(/^["']|["']$/g, "");
		if (firstColumn) names.push(firstColumn);
	}
	return names;
}

function runWrangler(args) {
	return execFileSync("npx", ["wrangler", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function readConfiguredBucketNameFromEnv(env) {
	return (
		env.KAOS_R2_BUCKET_NAME?.trim() ||
		env.KAOS_BUCKET_NAME?.trim() ||
		""
	);
}

function autoBindingDisabled(env) {
	const value = env.KAOS_AUTO_R2_BINDING;
	return typeof value === "string" && /^(0|false|off|no)$/i.test(value.trim());
}

function findBucketNameFromCurrentDeployment(workerName, bindingName) {
	const nameArgs = workerName ? ["--name", workerName] : [];
	let status;
	try {
		status = parseJsonOutput(runWrangler(["deployments", "status", "--json", ...nameArgs]));
	} catch {
		return null;
	}
	const directBucketName = extractR2BucketName(status, bindingName);
	if (directBucketName) return directBucketName;

	for (const versionId of extractVersionIds(status)) {
		try {
			const version = parseJsonOutput(runWrangler(["versions", "view", versionId, "--json", ...nameArgs]));
			const bucketName = extractR2BucketName(version, bindingName);
			if (bucketName) return bucketName;
		} catch {
			// Older accounts or first deploys may not have a readable version yet.
		}
	}
	return null;
}

function findExactR2BucketName(bindingName) {
	try {
		const names = extractBucketNamesFromListOutput(runWrangler(["r2", "bucket", "list"]));
		return names.find((name) => name === bindingName) ?? null;
	} catch {
		return null;
	}
}

export function resolveBucketName({ source, env = process.env, currentDeployment, r2BucketListOutput }) {
	const configuredBucketName = readConfiguredBucketNameFromEnv(env);
	if (configuredBucketName) {
		return { bucketName: configuredBucketName, source: "env" };
	}

	const deploymentBucketName = extractR2BucketName(currentDeployment, DEFAULT_BINDING_NAME);
	if (deploymentBucketName) {
		return { bucketName: deploymentBucketName, source: "current-deployment" };
	}

	const exactBucketName = extractBucketNamesFromListOutput(r2BucketListOutput ?? "")
		.find((name) => name === DEFAULT_BINDING_NAME);
	if (exactBucketName) {
		return { bucketName: exactBucketName, source: "r2-bucket-list" };
	}

	const workerName = readWorkerName(source);
	const liveDeploymentBucketName = findBucketNameFromCurrentDeployment(workerName, DEFAULT_BINDING_NAME);
	if (liveDeploymentBucketName) {
		return { bucketName: liveDeploymentBucketName, source: "current-deployment" };
	}

	const liveExactBucketName = findExactR2BucketName(DEFAULT_BINDING_NAME);
	if (liveExactBucketName) {
		return { bucketName: liveExactBucketName, source: "r2-bucket-list" };
	}

	return null;
}

export function autoBindR2(configPath = CONFIG_PATH, env = process.env) {
	if (autoBindingDisabled(env)) {
		console.log("KAOS R2 auto-binding disabled by KAOS_AUTO_R2_BINDING.");
		return false;
	}
	if (!existsSync(configPath)) {
		console.warn(`KAOS R2 auto-binding skipped: ${configPath} was not found.`);
		return false;
	}

	const source = readFileSync(configPath, "utf8");
	if (hasR2Binding(source, DEFAULT_BINDING_NAME)) {
		console.log(`KAOS R2 binding ${DEFAULT_BINDING_NAME} already exists in wrangler.toml.`);
		return false;
	}

	const resolved = resolveBucketName({ source, env });
	if (!resolved) {
		console.log(
			`KAOS R2 auto-binding skipped: no existing ${DEFAULT_BINDING_NAME} binding or explicit bucket name was found.`,
		);
		return false;
	}

	writeFileSync(configPath, appendR2Binding(source, resolved.bucketName, DEFAULT_BINDING_NAME));
	console.log(
		`KAOS R2 auto-binding added ${DEFAULT_BINDING_NAME} -> ${resolved.bucketName} (${resolved.source}).`,
	);
	return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	autoBindR2();
}
