import { TFile } from "obsidian";
import {
	buildKaosDashboardData,
	collectDashboardAttention,
	collectDashboardConflictArtifacts,
} from "../src/dashboard/dashboardData";
import { resolveRecoveryHistoryInitialSelection } from "../src/snapshots/recoveryHistorySelection";
import {
	resolveKaosDashboardMode,
	selectMobileOverviewMetrics,
} from "../src/dashboard/dashboardLayout";
import { formatDashboardDeviceName } from "../src/dashboard/deviceDisplay";
import { normalizeRecoveryStorageAuditReport } from "../src/sync/recoverySnapshotClient";
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
	new FakeTFile("notes/preserved.md", { mtime: 15, size: 25 }),
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
		episodeId: "episode-preserved",
		firstSeenAt: 1_777_000_000_000,
		lastSeenAt: 1_777_000_010_000,
	}, {
		path: "notes/path-collision.md",
		kind: "markdown",
		reason: "path-collision",
		firstSeenAt: 1_777_000_000_001,
		lastSeenAt: 1_777_000_010_001,
	}],
	remoteDeleteResolutionState: {
		markdownAvailable: true,
		blobAvailable: true,
		getFingerprint: (_kind, path) => path === "notes/preserved.md"
			? "markdown-delete-fingerprint"
			: null,
		isKeepLocalPending: () => false,
	},
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
	recoveryStorageStatus: {
		status: "ready",
		report: {
			status: "healthy",
			checkedAt: "2026-06-24T00:00:00Z",
			latestManifestId: "m1",
			latestIndexManifestId: "m1",
			latestStateManifestId: "m1",
			manifestCount: 1,
			manifestCountLowerBound: 1,
			checkedManifestCount: 1,
			issues: [],
			repairs: [],
			contentCheckLimited: false,
		},
	},
	recentChanges: {
		status: "ready",
		manifestCount: 1,
		limited: false,
		latestCreatedAt: "2026-06-24T01:00:00Z",
		lastAttempt: {
			attemptedAt: "2026-06-24T01:02:00Z",
			status: "created",
			manifestId: "m1",
			reason: null,
			changedCount: 1,
			forceFull: false,
			pending: null,
		},
		changes: [{
			manifestId: "m1",
			snapshotKind: "file-history",
			createdAt: "2026-06-24T01:00:00Z",
			fileId: "f1",
			changeKind: "modified",
			path: "notes/a.md",
			oldPath: null,
			newPath: null,
			device: "device-a",
			size: 10,
			contentHash: "hash",
			previousContentHash: "oldhash",
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
	const remoteDelete = attention.find((item) => item.path === "notes/preserved.md");
	const pathCollision = attention.find((item) => item.path === "notes/path-collision.md");
	assert(
		remoteDelete?.resolution?.kind === "remote-delete"
			&& remoteDelete.resolution.fileKind === "markdown"
			&& remoteDelete.resolution.reason === "remote-delete-missing-baseline",
		"remote-delete attention exposes explicit resolution metadata",
	);
	assert(remoteDelete?.resolution?.episodeId === "episode-preserved", "attention action is bound to its occurrence");
	assert(remoteDelete?.resolution?.remoteDeleteFingerprint === "markdown-delete-fingerprint", "attention action is bound to the current remote tombstone");
	assert(remoteDelete?.resolution?.localFile.kind === "file" && remoteDelete.resolution.localFile.mtime === 15, "attention action captures local file identity");
	assert(remoteDelete?.resolution?.canKeepLocal === true, "Keep local is enabled only when the local file and sync engine are ready");
	assert(remoteDelete?.resolution?.canAcceptRemoteDelete === true, "Accept remote delete is enabled for an authoritative tombstone");
	assert(pathCollision?.resolution === null, "non-delete preserved attention is not offered delete resolution");
	const structuralChange = attention.find((item) => item.kind === "structural-change");
	assert(
		structuralChange?.title === "ambiguous · old.md, new.md",
		"structural title uses the reason and path-free filenames",
	);
	assert(
		structuralChange?.structuralChange?.oldPaths[0] === "old.md"
			&& structuralChange.structuralChange.newPaths[0] === "new.md"
			&& structuralChange.structuralChange.contentHashPrefix === "123456789abc",
		"structural detail keeps old, new, and hash fields separate",
	);
	const manyStructural = collectDashboardAttention({
		...baseInput,
		reconciliationState: {
			...baseInput.reconciliationState,
			unresolvedStructuralChangeSample: [{
				oldPaths: ["old/a.md", "old/b.md"],
				newPaths: ["new/c.md", "new/d.md"],
				reason: "ambiguous-duplicate-content",
				contentHashPrefix: "abcdef123456",
			}],
		},
	}).find((item) => item.kind === "structural-change");
	assert(
		manyStructural?.title === "ambiguous-duplicate-content · a.md, b.md, c.md, d.md",
		"structural title shows every filename without +N truncation",
	);
	assert(
		attention
			.filter((item) => item.kind !== "preserved-unresolved")
			.every((item) => item.resolution === null),
		"non-file attention types do not expose remote-delete actions",
	);
}

console.log("\n--- Test 4: dashboard data preserves snapshot unavailable and recent changes ---");
{
	const data = buildKaosDashboardData(baseInput);
	assert(data.snapshotStatus.status === "unavailable", "snapshot unavailable preserved");
	assert(data.recoveryStorageStatus.status === "ready" && data.recoveryStorageStatus.report.status === "healthy", "recovery storage status preserved");
	assert(data.recentChanges.status === "ready" && data.recentChanges.changes.length === 1, "recent changes preserved");
	assert(data.recentChanges.status === "ready" && data.recentChanges.latestCreatedAt === "2026-06-24T01:00:00Z", "latest file history timestamp preserved");
	assert(data.recentChanges.status === "ready" && data.recentChanges.lastAttempt?.status === "created", "last file history attempt preserved");
	assert(data.recentChanges.status === "ready" && data.recentChanges.changes[0]?.previousContentHash === "oldhash", "previous content hash preserved for dashboard history navigation");
	assert(data.actions.snapshotsAvailable === false, "snapshot action disabled state represented");
	assert(data.attentionTotalCount === 5, "attention total includes entries hidden by collapsed/sample rows");
	assert(data.overview.some((metric) => metric.label === "Server receipt" && metric.value === "confirmed"), "server receipt metric built");
}

console.log("\n--- Test 4b: pending attachment publication disables competing actions ---");
{
	const attention = collectDashboardAttention({
		...baseInput,
		preservedUnresolvedEntries: [{
			...baseInput.preservedUnresolvedEntries[0]!,
			kind: "blob",
		}],
		remoteDeleteResolutionState: {
			...baseInput.remoteDeleteResolutionState!,
			isKeepLocalPending: (kind) => kind === "blob",
		},
	});
	const pending = attention.find((item) => item.path === "notes/preserved.md")?.resolution;
	assert(pending?.keepLocalPending === true, "pending publication is exposed to the view");
	assert(pending?.canKeepLocal === false, "pending publication disables duplicate Keep local");
	assert(pending?.canAcceptRemoteDelete === false, "pending publication disables competing Accept");
}

console.log("\n--- Test 4c: attention sampling reports the true total ---");
{
	const manyEntries = Array.from({ length: 25 }, (_, index) => ({
		path: `notes/attention-${index}.md`,
		kind: "markdown" as const,
		reason: "remote-delete-missing-baseline" as const,
		episodeId: `episode-${index}`,
		firstSeenAt: 1_777_000_000_000 + index,
		lastSeenAt: 1_777_000_010_000 + index,
	}));
	const sampled = buildKaosDashboardData({
		...baseInput,
		preservedUnresolvedEntries: manyEntries,
	});
	assert(
		sampled.attention.filter((item) => item.kind === "preserved-unresolved").length === 20,
		"the dashboard keeps a bounded preserved-unresolved sample",
	);
	assert(
		sampled.attentionTotalCount === 28,
		"the section count includes entries outside the sample",
	);
}

console.log("\n--- Test 4d: unavailable sync engines disable resolution actions ---");
{
	const attention = collectDashboardAttention({
		...baseInput,
		remoteDeleteResolutionState: undefined,
	});
	const resolution = attention.find((item) => item.path === "notes/preserved.md")?.resolution;
	assert(resolution?.canKeepLocal === false, "Keep local is disabled without a sync engine");
	assert(resolution?.canAcceptRemoteDelete === false, "Accept is disabled without a sync engine");
	assert(
		resolution?.keepLocalUnavailableReason?.includes("not initialized") === true,
		"the disabled action explains why it is unavailable",
	);
}

console.log("\n--- Test 4e: an already-missing local file can still accept remote delete ---");
{
	const attention = collectDashboardAttention({
		...baseInput,
		app: makeApp([]),
	});
	const resolution = attention.find((item) => item.path === "notes/preserved.md")?.resolution;
	assert(resolution?.localFile.kind === "missing", "missing local identity is captured");
	assert(resolution?.canKeepLocal === false, "a missing file cannot be kept locally");
	assert(resolution?.canAcceptRemoteDelete === true, "a missing file can clear the accepted marker");
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

console.log("\n--- Test 6: dashboard layout switches only for phones ---");
{
	assert(
		resolveKaosDashboardMode({ isMobile: true, isPhone: true, isTablet: false }) === "phone",
		"phone mobile app uses phone dashboard mode",
	);
	assert(
		resolveKaosDashboardMode({ isMobile: true, isPhone: false, isTablet: true }) === "desktop",
		"tablet mobile app keeps full dashboard mode",
	);
	assert(
		resolveKaosDashboardMode({ isMobile: false, isPhone: false, isTablet: false }) === "desktop",
		"desktop app keeps full dashboard mode",
	);
}

console.log("\n--- Test 7: mobile overview keeps actionable metrics ---");
{
	const data = buildKaosDashboardData(baseInput);
	const mobileMetrics = selectMobileOverviewMetrics(data.overview);
	const labels = mobileMetrics.map((metric) => metric.label);
	assert(labels.includes("Status"), "mobile overview keeps status");
	assert(labels.includes("Connection"), "mobile overview keeps connection");
	assert(labels.includes("Server receipt"), "mobile overview keeps server receipt");
	assert(labels.includes("Untracked"), "mobile overview keeps untracked count");
	assert(!labels.includes("Open files"), "mobile overview drops passive open-file metric");
}

console.log("\n--- Test 8: recovery storage audit response normalization is tolerant ---");
{
	const normalized = normalizeRecoveryStorageAuditReport({
		status: "repaired",
		checkedAt: "2026-06-24T02:00:00Z",
		latestManifestId: "m2",
		latestIndexManifestId: "m2",
		latestStateManifestId: "m2",
		manifestCountLowerBound: 2,
		checkedManifestCount: 1,
		contentCheckLimited: true,
		issues: [{ kind: "latest-state-missing", severity: "error", repairable: true, repaired: true }],
		repairs: [{ kind: "latest-state-missing", success: true }],
	});
	assert(normalized.status === "repaired", "known recovery storage status preserved");
	assert(normalized.manifestCount === 2, "manifestCount falls back to manifestCountLowerBound");
	assert(normalized.issues[0]?.message === "", "missing issue message normalizes to empty string");
	assert(normalized.repairs[0]?.success === true, "repair success normalizes");

	const unknown = normalizeRecoveryStorageAuditReport({ status: "surprise", issues: "bad" });
	assert(unknown.status === "unavailable", "unknown recovery storage status normalizes to unavailable");
	assert(unknown.issues.length === 0, "invalid issue list normalizes to empty");
}

console.log("\n--- Test 9: recovery history initial selection resolves dashboard target ---");
{
	const manifests = [{
		storageVersion: "v2" as const,
		manifestId: "m1",
		vaultId: "vault-1",
		kind: "file-history" as const,
		createdAt: "2026-06-24T01:00:00Z",
		day: "2026-06-24",
		reason: "automatic",
		pinned: false,
		changedCount: 1,
		contentHashes: ["hash"],
		changedEntries: [{
			fileId: "f1",
			kind: "modified" as const,
			path: "notes/a.md",
			contentHash: "hash",
			previousContentHash: "oldhash",
		}],
		stateHash: "state",
		manifestHash: "manifest",
	}];
	const resolved = resolveRecoveryHistoryInitialSelection(manifests, {
		initialManifestId: "m1",
		initialFileId: "f1",
		autoExpandDiff: true,
	});
	assert(resolved.selectedManifestId === "m1", "initial manifest selected");
	assert(resolved.selectedFileId === "f1", "initial file selected");
	assert(resolved.expandedDiffKey === "m1:f1", "diff auto-expands when a content hash is present");

	const fallback = resolveRecoveryHistoryInitialSelection(manifests, {
		initialManifestId: "missing",
		initialFileId: "f1",
		autoExpandDiff: true,
	});
	assert(fallback.selectedManifestId === "m1" && fallback.selectedFileId === null, "missing manifest falls back to timeline");
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
