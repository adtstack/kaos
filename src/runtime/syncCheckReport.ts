/**
 * Sync check report — pure verdict builder for the "Run sync check" command.
 *
 * The four silent-freeze mechanisms (wrong room / schema refusal / closed
 * projection gate / safety brake) all present as "sync does nothing". This
 * module turns locally available facts plus optional authenticated server
 * facts into an ordered, human-readable findings list with one overall tone.
 *
 * Constraints (house style — see safetyBrakePolicy.ts):
 *   - Synchronous (no async)
 *   - No Obsidian imports, no network
 *   - Pure: same inputs → same output
 */

export type SyncCheckTone = "ok" | "info" | "warn" | "error";

export interface SyncCheckFinding {
	readonly code: string;
	readonly tone: Exclude<SyncCheckTone, "ok">;
	readonly summary: string;
}

export interface SyncCheckLocalFacts {
	readonly pluginVersion: string;
	readonly clientSchemaVersion: number;
	/** Room schema version stored in the CRDT, null when absent. */
	readonly storedSchemaVersion: number | null;
	/** Non-null when checkSchemaVersion() rejects the room. */
	readonly schemaError: string | null;
	readonly connected: boolean;
	readonly providerSynced: boolean;
	readonly connectionStateKind: string;
	readonly activePathCount: number;
	readonly tombstonedPathCount: number;
	readonly localSyncableFileCount: number;
	readonly projectionGateReady: boolean;
	readonly projectionGateGeneration: number;
	readonly safetyBrakeTriggered: boolean | null;
	readonly blockedDivergenceCount: number;
	readonly idbError: boolean;
	readonly excludePatternCount: number;
	/** Approximate CRDT state size in bytes (full encode, computed on demand). */
	readonly docBytes: number;
	readonly roomDivergenceKind: "ok" | "stale-room-suspected" | "projection-stalled-suspected";
}

export interface SyncCheckServerFacts {
	readonly capabilities: {
		readonly serverVersion: string;
		readonly minSchemaVersion: number | null;
		readonly maxSchemaVersion: number | null;
		readonly minPluginVersion: string | null;
	} | null;
	readonly debug: {
		/** Room id echoed by the server, when the debug endpoint answered. */
		readonly roomId: string | null;
		readonly roomEchoMatches: boolean | null;
		readonly documentLoaded: boolean | null;
		readonly activePathCount: number | null;
		readonly schemaVersion: number | null;
		readonly persistenceHealthy: boolean | null;
	} | null;
	readonly error: string | null;
}

export interface SyncCheckReport {
	readonly tone: SyncCheckTone;
	readonly summary: string;
	readonly findings: readonly SyncCheckFinding[];
}

const TONE_RANK: Record<SyncCheckTone, number> = { ok: 0, info: 1, warn: 2, error: 3 };

export function buildSyncCheckReport(
	local: SyncCheckLocalFacts,
	server: SyncCheckServerFacts,
): SyncCheckReport {
	const findings: SyncCheckFinding[] = [];

	if (local.idbError) {
		findings.push({
			code: "idb-error",
			tone: "error",
			summary: "Local IndexedDB is failing — CRDT cache persistence is degraded.",
		});
	}
	if (local.schemaError) {
		findings.push({
			code: "schema-plugin-older-than-room",
			tone: "error",
			summary: `${local.schemaError} Update this plugin before syncing again.`,
		});
	}
	if (
		!local.schemaError &&
		server.capabilities &&
		server.capabilities.maxSchemaVersion !== null &&
		server.capabilities.maxSchemaVersion > local.clientSchemaVersion
	) {
		findings.push({
			code: "schema-plugin-older-than-server",
			tone: "error",
			summary:
				`Server ${server.capabilities.serverVersion} accepts schema up to ` +
				`${server.capabilities.maxSchemaVersion}, this plugin speaks ` +
				`${local.clientSchemaVersion}. Update the plugin.`,
		});
	}
	if (
		server.capabilities &&
		server.capabilities.minSchemaVersion !== null &&
		server.capabilities.minSchemaVersion > local.clientSchemaVersion
	) {
		findings.push({
			code: "schema-server-older-than-plugin",
			tone: "error",
			summary:
				`Server ${server.capabilities.serverVersion} requires schema ≥ ` +
				`${server.capabilities.minSchemaVersion}; this plugin speaks ` +
				`${local.clientSchemaVersion}. Update the server (kaosctl update).`,
		});
	}
	if (server.debug?.roomEchoMatches === false) {
		findings.push({
			code: "room-echo-mismatch",
			tone: "error",
			summary:
				`Server answered for room "${server.debug.roomId}" but this device is ` +
				`configured for another room — host routing is inconsistent.`,
		});
	}
	if (local.roomDivergenceKind === "stale-room-suspected") {
		findings.push({
			code: "stale-room-suspected",
			tone: "warn",
			summary:
				`Room holds ${local.activePathCount} synced files vs ${local.localSyncableFileCount} ` +
				"on this device's disk — likely paired to a different or outdated room. " +
				"Compare the vaultId on every device (Settings → Sync status).",
		});
	}
	if (local.roomDivergenceKind === "projection-stalled-suspected") {
		findings.push({
			code: "projection-stalled-suspected",
			tone: "warn",
			summary:
				`Room holds ${local.activePathCount} files vs ${local.localSyncableFileCount} on ` +
				"disk while remote projection is paused — downloads are frozen by the " +
				"closed gate, not by the network.",
		});
	}
	if (
		local.providerSynced &&
		!local.projectionGateReady &&
		local.roomDivergenceKind === "ok"
	) {
		findings.push({
			code: "projection-gate-closed",
			tone: "warn",
			summary:
				`Remote projection gate is closed for generation ${local.projectionGateGeneration} ` +
				"— no remote changes reach disk until the shared exclude policy settles.",
		});
	}
	if (local.safetyBrakeTriggered === true || local.blockedDivergenceCount > 0) {
		findings.push({
			code: "safety-brake-active",
			tone: "warn",
			summary:
				`Reconcile safety brake is holding ${local.blockedDivergenceCount} destructive ` +
				"overwrite(s). Additive downloads continue; review the divergence or export diagnostics.",
		});
	}
	if (server.error) {
		findings.push({
			code: "server-unreachable",
			tone: "warn",
			summary: `Server facts unavailable: ${server.error}`,
		});
	}
	if (
		server.debug &&
		server.debug.activePathCount !== null &&
		Math.abs(server.debug.activePathCount - local.activePathCount) > 50
	) {
		findings.push({
			code: "room-path-count-mismatch",
			tone: "info",
			summary:
				`Server room holds ${server.debug.activePathCount} active paths, local CRDT ` +
				`holds ${local.activePathCount} — state still converging or a stale local cache.`,
		});
	}
	if (server.debug && server.debug.documentLoaded === false) {
		findings.push({
			code: "server-cold-room",
			tone: "info",
			summary:
				"Server room document is cold (not loaded) — path counts unavailable until it warms up.",
		});
	}

	let tone: SyncCheckTone = "ok";
	for (const finding of findings) {
		if (TONE_RANK[finding.tone] > TONE_RANK[tone]) tone = finding.tone;
	}
	const firstFinding = findings[0];
	const summary = findings.length === 0 || firstFinding === undefined
		? `Healthy — room ${local.activePathCount} files (${Math.round(local.docBytes / 1024)} KB doc), ` +
			`disk ${local.localSyncableFileCount}, gate ${local.projectionGateReady ? "open" : "closed"}.`
		: findings.length === 1
			? firstFinding.summary
			: `${findings.length} findings (first: ${firstFinding.summary})`;
	return { tone, summary, findings };
}
