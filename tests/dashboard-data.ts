import { TFile } from "obsidian";
import {
	buildKaosDashboardData,
	collectDashboardAttention,
	collectDashboardConflictArtifacts,
} from "../src/dashboard/dashboardData";
import { formatDashboardDeviceName } from "../src/dashboard/deviceDisplay";
import type { KaosDashboardCollectorInput } from "../src/dashboard/dashboardTypes";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
	} else {
		console.error(`  FAIL  ${message}`);
		failed++;
	}
}

class FakeTFile extends TFile {
	constructor(
		readonly path: string,
		readonly stat: { mtime: number; size: number },
	) {
		super();
	}
}

function makeApp(files: FakeTFile[]) {
	return {
		vault: {
			getFiles: () => files,
			getAbstractFileByPath: (path: string) =>
				files.find((file) => file.path === path) ?? null,
		},
	} as unknown as import("obsidian").App;
}

const files = [
	new FakeTFile("notes/a.md", { mtime: 10, size: 12 }),
	new FakeTFile("notes/a (KAOS conflict - disk from device-a 2026-06-23T14-20-40Z).md", { mtime: 20, size: 13 }),
	new FakeTFile("notes/b (KAOS conflict - crdt from device-b 2026-06-24T09-00-00Z).md", { mtime: 30, size: 14 }),
	new FakeTFile("assets/img.png", { mtime: 11, size: 100 }),
	new FakeTFile("assets/img (KAOS remote conflict 2026-06-23T15-00-00Z).png", { mtime: 21, size: 101 }),
];

const baseInput: KaosDashboardCollectorInput = {
	app: makeApp(files),
	generatedAt: "2026-06-24T00:00:00Z",
	settings: {
		deviceName: "device-local",
		vaultId: "vault-1",
		attachmentSyncEnabled: true,
		externalEditPolicy: "always",
	},
	syncStatusLabel: "connected",
	connectionLabel: "online",
	connectionTone: "ok",
	reconciliationState: {
		reconciled: true,
		reconcileInFlight: false,
		reconcilePending: false,
		lastReconcileStats: {
			at: "2026-06-24T00:00:00Z",
			mode: "authoritative",
			plannedCreates: 0,
			plannedUpdates: 0,
			flushedCreates: 0,
			flushedUpdates: 0,
			safetyBrakeTriggered: false,
			safetyBrakeReason: null,
		},
		lastReconciledGeneration: 4,
		untrackedFileCount: 0,
		blockedDivergenceCount: 1,
		lastBlockedDivergenceAt: "2026-06-24T01:00:00Z",
		blockedDivergenceSample: [{ ext: ".md", hash: "abcd" }],
		unresolvedStructuralChangeCount: 1,
		unresolvedStructuralChangeSample: [{
			oldPaths: ["old.md"],
			newPaths: ["new.md"],
			reason: "ambiguous",
			contentHashPrefix: "123456789abc",
		}],
	},
	vaultSync: {
		connected: true,
		providerSynced: true,
		localReady: true,
		pathToIdCount: 2,
		activePathCount: 2,
		tombstonedPathCount: 0,
		blobPathCount: 1,
		serverReceipt: {
			serverAppliedLocalState: true,
			lastServerReceiptEchoAt: 1,
			lastKnownServerReceiptEchoAt: 1,
			candidatePersistenceHealthy: true,
			hasUnconfirmedCandidate: false,
			persistenceUnavailable: false,
		},
	},
	diskMirror: {
		queuedWrites: [],
		debounceCount: 0,
		openDebounceCount: 0,
		suppressedCount: 0,
	},
	blobSync: {
		pendingUploads: 0,
		pendingDownloads: 0,
		processingUploads: 0,
		processingDownloads: 0,
		permanentUploadFailures: 0,
		permanentDownloadFailures: 0,
		blobConflictArtifacts: 1,
		localOnlyBlobConflictPaths: 1,
	},
	preservedUnresolvedEntries: [{
		path: "notes/preserved.md",
		kind: "markdown",
		reason: "remote-delete-missing-baseline",
		firstSeenAt: 1_777_000_000_000,
		lastSeenAt: 1_777_000_010_000,
	}],
	frontmatterQuarantineEntries: [{
		path: "notes/frontmatter.md",
		firstSeenAt: 1_777_000_020_000,
		lastSeenAt: 1_777_000_030_000,
		direction: "disk-to-crdt",
		reasons: ["unsafe-frontmatter"],
		count: 2,
	}],
	diskIndex: {
		"notes/a (KAOS conflict - disk from device-a 2026-06-23T14-20-40Z).md": {
			mtime: 20,
			size: 13,
			contentHash: "h1",
		},
		"notes/a.md": {
			mtime: 10,
			size: 12,
			contentHash: "h2",
		},
	},
	snapshotStatus: { status: "unavailable", message: "Snapshot storage is unavailable." },
	recentChanges: {
		status: "ready",
		manifestCount: 1,
		limited: false,
		changes: [{
			manifestId: "m1",
			snapshotKind: "delta",
			createdAt: "2026-06-24T01:00:00Z",
			fileId: "f1",
			changeKind: "modified",
			path: "notes/a.md",
			oldPath: null,
			newPath: null,
			device: "device-a",
			size: 10,
			contentHash: "hash",
		}],
	},
	openFileCount: 1,
	snapshotsAvailable: false,
};

console.log("\n--- Test 1: conflict artifacts are collected and sorted ---");
{
	const conflicts = collectDashboardConflictArtifacts(baseInput);
	assert(conflicts.length === 3, "three conflict artifacts collected");
	assert(conflicts[0]?.artifactPath.includes("2026-06-24T09-00-00Z") ?? false, "newest conflict first");
	assert(conflicts.some((item) => item.kind === "blob" && item.source === "remote"), "blob conflict included");
}

console.log("\n--- Test 2: original existence and disk index flags are computed ---");
{
	const conflicts = collectDashboardConflictArtifacts(baseInput);
	const a = conflicts.find((item) => item.artifactPath.includes("device-a"));
	const b = conflicts.find((item) => item.artifactPath.includes("device-b"));
	assert(a?.originalExists === true, "existing original detected");
	assert(a?.artifactIndexed === true, "artifact disk index flag true");
	assert(a?.originalIndexed === true, "original disk index flag true");
	assert(b?.originalExists === false, "missing original detected");
}

console.log("\n--- Test 3: attention aggregation includes all local attention types ---");
{
	const attention = collectDashboardAttention(baseInput);
	assert(attention.some((item) => item.kind === "preserved-unresolved"), "preserved unresolved included");
	assert(attention.some((item) => item.kind === "structural-change"), "structural change included");
	assert(attention.some((item) => item.kind === "blocked-divergence"), "blocked divergence included");
	assert(attention.some((item) => item.kind === "frontmatter-quarantine"), "frontmatter quarantine included");
}

console.log("\n--- Test 4: dashboard data preserves snapshot unavailable and recent changes ---");
{
	const data = buildKaosDashboardData(baseInput);
	assert(data.snapshotStatus.status === "unavailable", "snapshot unavailable preserved");
	assert(data.recentChanges.status === "ready" && data.recentChanges.changes.length === 1, "recent changes preserved");
	assert(data.actions.snapshotsAvailable === false, "snapshot action disabled state represented");
	assert(data.overview.some((metric) => metric.label === "Server receipt" && metric.value === "confirmed"), "server receipt metric built");
}

console.log("\n--- Test 5: dashboard device display marks this device ---");
{
	assert(
		formatDashboardDeviceName("device-local", "device-local") === "device-local (this device)",
		"current device display is annotated",
	);
	assert(
		formatDashboardDeviceName("device-a", "device-local") === "device-a",
		"remote device display is unchanged",
	);
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
