#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	analyzeEnsureFileSource,
	formatEnsureFileViolation,
} from "./ensure-file-writer-detector.mjs";
import { runEnsureFileWriterDetectorAdversarialTests } from "./ensure-file-writer-alias-regressions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const APPROVED_ENSURE_FILE_WRITERS = Object.freeze([
	["src/sync/vaultSync.ts", "reconcileVault", "authoritative-disk-snapshot-seed", 1],
	["src/sync/diskMirror.ts", "handleRemoteDeleteUnlocked", "dirty-local-wins-remote-delete-revival", 1],
	["src/runtime/reconciliationController.ts", "importUntrackedFiles", "explicit-untracked-disk-import", 1],
	["src/runtime/reconciliationController.ts", "keepLocalRemoteDeletedMarkdown", "confirmed-attention-keep-local", 1],
	["src/runtime/reconciliationController.ts", "syncFileFromDisk", "closed-file-missing-crdt-admission", 1],
	["src/runtime/reconciliationController.ts", "resolvePreservedUnresolvedFromFreshDiskEvent", "fresh-disk-recovery-admission", 1],
	["src/runtime/reconciliationController.ts", "handleBoundFileSyncGap", "controller-certified-open-path-admission", 1],
	["qa/harness/qaDebugApi.ts", "__qaOnlyForceCrdtContentUnsafe", "explicit-qa-force-route", 1],
]);

const REQUIRED_SOURCE_MARKERS = Object.freeze(new Map([
	["authoritative-disk-snapshot-seed", "canSeedSnapshot"],
	["dirty-local-wins-remote-delete-revival", "isRemoteDeleteOperationCurrent"],
	["explicit-untracked-disk-import", "shouldBlockFrontmatterIngest"],
	["confirmed-attention-keep-local", "acquireMarkdownRemoteDeleteResolution"],
	["closed-file-missing-crdt-admission", "commitClosedFileReconcileMutation"],
	["fresh-disk-recovery-admission", "episodeIsCurrent"],
	["controller-certified-open-path-admission", "captureOpenEditorMutationTicket"],
	["explicit-qa-force-route", "__KAOS_QA_HARNESS_ENABLED__"],
]));

const APPROVED_WRITER_OWNER_PATHS = Object.freeze(new Map([
	["authoritative-disk-snapshot-seed", "VaultSync.reconcileVault"],
	["dirty-local-wins-remote-delete-revival", "DiskMirror.handleRemoteDeleteUnlocked"],
	["explicit-untracked-disk-import", "ReconciliationController.importUntrackedFiles"],
	["confirmed-attention-keep-local", "ReconciliationController.keepLocalRemoteDeletedMarkdown.withActiveOpId#arg1"],
	["closed-file-missing-crdt-admission", "ReconciliationController.syncFileFromDisk.commit[stage=\"open-unbound-disk-seed\"].withActiveOpId#arg1"],
	["fresh-disk-recovery-admission", "ReconciliationController.resolvePreservedUnresolvedFromFreshDiskEvent.commit[stage=\"preserved-unresolved-fresh-local-event\"].withActiveOpId#arg1[branch=else]"],
	["controller-certified-open-path-admission", "ReconciliationController.handleBoundFileSyncGap.commitMutation#arg2[arg0=\"bound-file-local-only-seed\"][branch=else][branch=then]"],
	["explicit-qa-force-route", "buildQaDebugApi.api.__qaOnlyForceCrdtContentUnsafe"],
]));

const REQUIRED_MARKER_OWNER_PATHS = Object.freeze(new Map([
	["authoritative-disk-snapshot-seed", "VaultSync.reconcileVault"],
	["dirty-local-wins-remote-delete-revival", "DiskMirror.handleRemoteDeleteUnlocked"],
	["explicit-untracked-disk-import", "ReconciliationController.importUntrackedFiles"],
	["confirmed-attention-keep-local", "ReconciliationController.keepLocalRemoteDeletedMarkdown"],
	["closed-file-missing-crdt-admission", "ReconciliationController.syncFileFromDisk"],
	["fresh-disk-recovery-admission", "ReconciliationController.resolvePreservedUnresolvedFromFreshDiskEvent"],
	["controller-certified-open-path-admission", "ReconciliationController.handleBoundFileSyncGap"],
	["explicit-qa-force-route", "buildQaDebugApi.api.__qaOnlyForceCrdtContentUnsafe"],
]));

function listTypeScriptFiles(relativeDir) {
	const absoluteDir = path.join(ROOT, relativeDir);
	const files = [];
	for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
		const relativePath = path.posix.join(relativeDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listTypeScriptFiles(relativePath));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relativePath);
	}
	return files;
}

function inventoryRows(counts, includeReasons) {
	return [...counts.entries()]
		.map(([key, count]) => {
			const [file, ownerPath] = key.split("\u0000");
			const approved = APPROVED_ENSURE_FILE_WRITERS.find(
				([approvedFile, , reason]) =>
					approvedFile === file
					&& APPROVED_WRITER_OWNER_PATHS.get(reason) === ownerPath,
			);
			return includeReasons && approved
				? [file, ownerPath, approved[2], count]
				: [file, ownerPath, count];
		})
		.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

runEnsureFileWriterDetectorAdversarialTests();

const failures = [];
const observedCounts = new Map();
const ownerEvidence = new Map();
const ownerNodeCounts = new Map();
const propertyViolations = [];

const sourceFiles = [...listTypeScriptFiles("src"), ...listTypeScriptFiles("qa")].sort();
for (const relativePath of sourceFiles) {
	// product-main.js is generated and is not TypeScript, but keep the exclusion
	// explicit so widening the extension filter cannot silently admit it later.
	if (relativePath === "qa/obsidian-harness/product-main.js") continue;
	const absolutePath = path.join(ROOT, relativePath);
	const sourceText = fs.readFileSync(absolutePath, "utf8");
	const analysis = analyzeEnsureFileSource(relativePath, sourceText);
	for (const [key, count] of analysis.observedCounts) {
		observedCounts.set(key, (observedCounts.get(key) ?? 0) + count);
	}
	for (const [key, evidence] of analysis.ownerEvidence) {
		ownerEvidence.set(key, evidence);
	}
	for (const [key, count] of analysis.ownerNodeCounts) {
		ownerNodeCounts.set(key, (ownerNodeCounts.get(key) ?? 0) + count);
	}
	propertyViolations.push(...analysis.violations);
}

if (propertyViolations.length > 0) {
	const counts = Object.fromEntries(
		[...propertyViolations.reduce((byCategory, violation) => {
			byCategory.set(violation.category, (byCategory.get(violation.category) ?? 0) + 1);
			return byCategory;
		}, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)),
	);
	failures.push(
		`ensureFile access violations by category=${JSON.stringify(counts)}:\n  `
		+ propertyViolations.map(formatEnsureFileViolation).join("\n  "),
	);
}

const approvedCounts = new Map(
	APPROVED_ENSURE_FILE_WRITERS.map(([file, method, , count]) => [`${file}\u0000${method}`, count]),
);
const observedRows = inventoryRows(observedCounts, true);
const approvedRows = APPROVED_ENSURE_FILE_WRITERS
	.map(([file, , reason, count]) => [file, APPROVED_WRITER_OWNER_PATHS.get(reason), reason, count])
	.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

if (JSON.stringify(observedRows) !== JSON.stringify(approvedRows)) {
	failures.push(
		"observed ensureFile writers differ from the approved multiset"
		+ `\n  observed=${JSON.stringify(observedRows, null, 2).replace(/\n/g, "\n  ")}`
		+ `\n  approved=${JSON.stringify(approvedRows, null, 2).replace(/\n/g, "\n  ")}`,
	);
}

for (const [file, method, reason] of APPROVED_ENSURE_FILE_WRITERS) {
	const writerPath = APPROVED_WRITER_OWNER_PATHS.get(reason);
	const writerOwnerCount = writerPath
		? ownerNodeCounts.get(`${file}\u0000${writerPath}`) ?? 0
		: 0;
	if (writerOwnerCount !== 1) {
		failures.push(
			`${file}:${method} must resolve to exactly one lexical writer owner; `
			+ `path=${writerPath ?? "missing"} count=${writerOwnerCount}`,
		);
	}
}

for (const [file, method, reason] of APPROVED_ENSURE_FILE_WRITERS) {
	const marker = REQUIRED_SOURCE_MARKERS.get(reason);
	const ownerPath = REQUIRED_MARKER_OWNER_PATHS.get(reason);
	if (!marker) {
		failures.push(`approved reason has no required source marker: ${reason}`);
		continue;
	}
	if (!ownerPath) {
		failures.push(`approved reason has no required marker owner path: ${reason}`);
		continue;
	}
	const ownerKey = `${file}\u0000${ownerPath}`;
	const markerOwnerCount = ownerNodeCounts.get(ownerKey) ?? 0;
	if (markerOwnerCount !== 1) {
		failures.push(
			`${file}:${method} must resolve to exactly one policy marker owner; `
			+ `path=${ownerPath} count=${markerOwnerCount}`,
		);
		continue;
	}
	const evidence = ownerEvidence.get(ownerKey);
	const hasMarker = reason === "explicit-qa-force-route"
		? evidence?.runtimeIdentifiers.has(marker) === true
		: evidence?.calls.has(marker) === true;
	if (!hasMarker) {
		failures.push(`${file}:${method} is missing policy marker ${marker} for ${reason}`);
	}
}

const editorWriterCount = [...observedCounts.entries()]
	.filter(([key]) => key.startsWith("src/sync/editorBinding.ts\u0000"))
	.reduce((sum, [, count]) => sum + count, 0);
if (editorWriterCount !== 0) {
	failures.push(`src/sync/editorBinding.ts must have zero ensureFile calls; observed ${editorWriterCount}`);
}

if (failures.length > 0) {
	console.error("ensure-file-writer-allowlist: FAIL");
	for (const failure of failures) console.error(`\n${failure}`);
	process.exit(1);
}

console.log(`ensure-file-writer-allowlist: PASS (${approvedCounts.size} approved writers)`);
