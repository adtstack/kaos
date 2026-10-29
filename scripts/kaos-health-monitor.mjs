#!/usr/bin/env node
/**
 * KAOS Headless Host Health Monitor
 *
 * Operational health check script designed to run every 15 minutes (via cron or systemd timer).
 * Detects silent failures:
 *   1. Daemon process down or status.json stale (> 3m without update)
 *   2. Persistent disconnection / offline state (> 5m warn, > 10m crit)
 *   3. Stalled server upload pipeline (lastServerReceiptEchoAt > 1 hour old)
 *   4. Head-of-line blocking / reconcile loops / preserved conflict accumulation
 *
 * Provides safe operational advice: warns operators against blind restarts that
 * could clobber uncommitted local disk modifications.
 *
 * Exit codes:
 *   0: HEALTHY (OK)
 *   1: WARNING
 *   2: CRITICAL
 */

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import http from "node:http";
import https from "node:https";

const DEFAULT_CANDIDATE_STATUS_PATHS = [
	"/var/lib/kaos-headless/status.json",
	"/opt/kaos/status.json",
	process.env.HOME ? `${process.env.HOME}/.local/share/kaos-headless/status.json` : null,
	"./status.json",
].filter(Boolean);

const DEFAULT_ECHO_STALE_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_OFFLINE_WARN_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_OFFLINE_CRIT_MS = 10 * 60 * 1000; // 10 minutes
const STATUS_FRESHNESS_MAX_MS = 3 * 60 * 1000; // 3 minutes

function parseArgs(args) {
	const options = {
		statusFile: null,
		echoStaleMs: DEFAULT_ECHO_STALE_MS,
		offlineWarnMs: DEFAULT_OFFLINE_WARN_MS,
		offlineCritMs: DEFAULT_OFFLINE_CRIT_MS,
		webhookUrl: null,
		json: false,
		quiet: false,
		help: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--quiet" || arg === "-q") {
			options.quiet = true;
		} else if (arg === "--status-file" && i + 1 < args.length) {
			options.statusFile = args[++i];
		} else if (arg.startsWith("--status-file=")) {
			options.statusFile = arg.slice("--status-file=".length);
		} else if (arg === "--notify-webhook" && i + 1 < args.length) {
			options.webhookUrl = args[++i];
		} else if (arg.startsWith("--notify-webhook=")) {
			options.webhookUrl = arg.slice("--notify-webhook=".length);
		} else if (arg === "--echo-stale-ms" && i + 1 < args.length) {
			options.echoStaleMs = Number.parseInt(args[++i], 10);
		} else if (arg === "--offline-warn-ms" && i + 1 < args.length) {
			options.offlineWarnMs = Number.parseInt(args[++i], 10);
		} else if (arg === "--offline-crit-ms" && i + 1 < args.length) {
			options.offlineCritMs = Number.parseInt(args[++i], 10);
		}
	}
	return options;
}

function printUsage() {
	console.log(`
Usage: node scripts/kaos-health-monitor.mjs [options]

Options:
  --status-file <path>     Path to status.json (default: checks standard locations)
  --echo-stale-ms <ms>     Max ms without server receipt echo before CRITICAL (default: 3600000 = 1h)
  --offline-warn-ms <ms>   Max ms offline before WARNING (default: 300000 = 5m)
  --offline-crit-ms <ms>   Max ms offline before CRITICAL (default: 600000 = 10m)
  --notify-webhook <url>   HTTP/HTTPS Webhook URL to POST JSON alert on WARN/CRITICAL
  --json                   Output structured JSON result
  --quiet, -q              Suppress OK output, only print WARN/CRITICAL
  --help, -h               Show this help message

Exit Codes:
  0: OK (Healthy)
  1: WARNING
  2: CRITICAL
`);
}

function findStatusFile(specifiedPath) {
	if (specifiedPath) {
		const resolved = resolve(specifiedPath);
		return existsSync(resolved) ? resolved : null;
	}
	for (const candidate of DEFAULT_CANDIDATE_STATUS_PATHS) {
		if (candidate && existsSync(candidate)) {
			return resolve(candidate);
		}
	}
	return null;
}

async function postWebhook(urlStr, payload) {
	try {
		const parsed = new URL(urlStr);
		const data = JSON.stringify(payload);
		const client = parsed.protocol === "https:" ? https : http;

		return new Promise((resolvePromise) => {
			const req = client.request(parsed, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(data),
				},
				timeout: 5000,
			}, (res) => {
				res.resume();
				resolvePromise(res.statusCode >= 200 && res.statusCode < 300);
			});
			req.on("error", () => resolvePromise(false));
			req.on("timeout", () => {
				req.destroy();
				resolvePromise(false);
			});
			req.write(data);
			req.end();
		});
	} catch {
		return false;
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printUsage();
		process.exit(0);
	}

	const issues = [];
	let severity = "OK"; // "OK" | "WARN" | "CRITICAL"

	function addIssue(level, code, message, details = {}) {
		issues.push({ level, code, message, details });
		if (level === "CRITICAL") {
			severity = "CRITICAL";
		} else if (level === "WARN" && severity !== "CRITICAL") {
			severity = "WARN";
		}
	}

	const statusPath = findStatusFile(options.statusFile);
	if (!statusPath) {
		addIssue("CRITICAL", "STATUS_FILE_MISSING", "KAOS status.json file could not be found. Headless daemon is likely not running.");
		return finish(severity, issues, null, options);
	}

	let fileStat;
	try {
		fileStat = await stat(statusPath);
	} catch (err) {
		addIssue("CRITICAL", "STATUS_FILE_STAT_FAILED", `Failed to stat status file: ${err.message}`);
		return finish(severity, issues, null, options);
	}

	const now = Date.now();
	const fileAgeMs = now - fileStat.mtimeMs;
	if (fileAgeMs > STATUS_FRESHNESS_MAX_MS) {
		addIssue("CRITICAL", "STATUS_FILE_STALE", `status.json has not been updated in ${Math.round(fileAgeMs / 1000)}s (> ${STATUS_FRESHNESS_MAX_MS / 1000}s). Daemon may be hung or killed.`);
	}

	let status;
	try {
		const raw = await readFile(statusPath, "utf8");
		status = JSON.parse(raw);
	} catch (err) {
		addIssue("CRITICAL", "STATUS_PARSE_FAILED", `Failed to parse status.json: ${err.message}`);
		return finish(severity, issues, null, options);
	}

	// 1. Process Check
	if (status.daemon?.pid) {
		try {
			// kill(pid, 0) tests process existence without killing it
			process.kill(status.daemon.pid, 0);
		} catch (err) {
			addIssue("CRITICAL", "DAEMON_PID_DEAD", `Recorded daemon PID ${status.daemon.pid} is not running: ${err.message}`);
		}
	}

	// 2. Connection Check
	const connStatus = status.connection?.status ?? "unknown";
	if (connStatus !== "connected") {
		const connAgeMs = fileAgeMs;
		if (status.connection?.fatalAuthCode) {
			addIssue("CRITICAL", "FATAL_AUTH_CODE", `Fatal authentication error: ${status.connection.fatalAuthCode}`);
		} else if (connAgeMs > options.offlineCritMs) {
			addIssue("CRITICAL", "CONNECTION_OFFLINE_LONG", `Connection state is "${connStatus}" for > ${Math.round(options.offlineCritMs / 60000)}m.`);
		} else if (connAgeMs > options.offlineWarnMs) {
			addIssue("WARN", "CONNECTION_OFFLINE_WARN", `Connection state is "${connStatus}" for > ${Math.round(options.offlineWarnMs / 60000)}m.`);
		} else {
			addIssue("WARN", "CONNECTION_NOT_CONNECTED", `Connection state is "${connStatus}".`);
		}
	}

	// 3. Server Receipt Echo Check (Upload Pipeline Stalled)
	const lastEchoAt = status.sync?.lastServerReceiptEchoAt ?? status.sync?.lastKnownServerReceiptEchoAt ?? null;
	if (lastEchoAt !== null) {
		const echoAgeMs = now - lastEchoAt;
		if (echoAgeMs > options.echoStaleMs) {
			const hours = (echoAgeMs / 3600000).toFixed(1);
			addIssue("CRITICAL", "RECEIPT_ECHO_STALLED", `lastServerReceiptEchoAt is ${hours}h old (> ${options.echoStaleMs / 3600000}h). Upload transmission may be stalled!`, {
				lastEchoAt,
				hoursAgo: hours,
			});
		}
	} else if (status.daemon?.uptimeSeconds > 600) {
		addIssue("WARN", "NO_RECEIPT_ECHO_SEEN", "No server receipt echo has been recorded since startup (> 10m).");
	}

	// 4. Reconcile Loop & Divergence Checks
	if (status.sync?.reconcilePending) {
		addIssue("WARN", "RECONCILE_PENDING", "Reconciliation pass is pending.");
	}

	// 5. Attention & Conflict Items
	const attentionCount = status.attention?.totalCount ?? 0;
	if (attentionCount > 0) {
		const items = status.attention?.items ?? [];
		const conflictItems = items.filter(
			(i) => i.reason?.includes("conflict") || i.kind?.includes("conflict") || i.type === "preservedUnresolved"
		);
		if (conflictItems.length > 0) {
			addIssue("WARN", "UNRESOLVED_CONFLICTS", `Found ${conflictItems.length} unresolved conflict / preserved entries.`, {
				conflicts: conflictItems.map((c) => ({ path: c.path, reason: c.reason })),
			});
		}
	}

	return finish(severity, issues, status, options);
}

async function finish(severity, issues, status, options) {
	const report = {
		timestamp: new Date().toISOString(),
		severity,
		statusFile: options.statusFile,
		vaultRoot: status?.vaultRoot ?? null,
		pid: status?.daemon?.pid ?? null,
		connectionStatus: status?.connection?.status ?? null,
		lastServerReceiptEchoAt: status?.sync?.lastServerReceiptEchoAt ?? null,
		issues,
	};

	if (options.webhookUrl && severity !== "OK") {
		await postWebhook(options.webhookUrl, report);
	}

	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		if (severity === "OK") {
			if (!options.quiet) {
				console.log(`[OK] KAOS Headless Host is healthy (PID ${status?.daemon?.pid}, ${status?.connection?.status}, last echo: ${status?.sync?.lastServerReceiptEchoAt ? new Date(status.sync.lastServerReceiptEchoAt).toISOString() : "none"})`);
			}
		} else {
			const icon = severity === "CRITICAL" ? "🔴" : "🟡";
			console.error(`\n${icon} [${severity}] KAOS Headless Host Health Alert (${issues.length} issue(s) detected):`);
			for (const issue of issues) {
				console.error(`  - [${issue.level}] ${issue.code}: ${issue.message}`);
				if (issue.details?.conflicts) {
					for (const c of issue.details.conflicts.slice(0, 5)) {
						console.error(`      * ${c.path} (${c.reason})`);
					}
				}
			}

			console.error(`
═══════════════════════════════════════════════════════════════════════════════
⚠️  CRITICAL OPERATIONAL NOTICE:
Do NOT blindly restart the service (\`systemctl restart kaos-headless-host\`)!
If local edits exist on disk, a cold restart before upload may overwrite them.
Recommended Safe Diagnosis Steps:
  1. Inspect vault git status:
     cd ${status?.vaultRoot ?? "<vaultRoot>"} && git status -s
  2. Check for emergency safety backups:
     ls -la ${status?.vaultRoot ?? "<vaultRoot>"}/.kaos-safety-backup/
  3. Inspect recent service logs:
     journalctl -u kaos-headless-host -n 80 --no-pager
═══════════════════════════════════════════════════════════════════════════════
`);
		}
	}

	const exitCode = severity === "CRITICAL" ? 2 : severity === "WARN" ? 1 : 0;
	process.exit(exitCode);
}

main().catch((err) => {
	console.error(`[CRITICAL] Health monitor crashed: ${err.message}`);
	process.exit(2);
});
