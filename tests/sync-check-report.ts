import {
	buildSyncCheckReport,
	type SyncCheckLocalFacts,
	type SyncCheckServerFacts,
} from "../src/runtime/syncCheckReport";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

const healthyLocal: SyncCheckLocalFacts = {
	pluginVersion: "1.13.3",
	clientSchemaVersion: 4,
	storedSchemaVersion: 4,
	schemaError: null,
	connected: true,
	providerSynced: true,
	connectionStateKind: "online",
	activePathCount: 1200,
	tombstonedPathCount: 10,
	localSyncableFileCount: 1200,
	projectionGateReady: true,
	projectionGateGeneration: 3,
	safetyBrakeTriggered: false,
	blockedDivergenceCount: 0,
	idbError: false,
	excludePatternCount: 1,
	docBytes: 4 * 1024 * 1024,
	roomDivergenceKind: "ok",
};

const healthyServer: SyncCheckServerFacts = {
	capabilities: {
		serverVersion: "0.8.2",
		minSchemaVersion: 4,
		maxSchemaVersion: 4,
		minPluginVersion: "1.9.4",
	},
	debug: {
		roomId: "vault-x",
		roomEchoMatches: true,
		documentLoaded: true,
		activePathCount: 1200,
		schemaVersion: 4,
		persistenceHealthy: true,
	},
	error: null,
};

console.log("\n--- Test 1: healthy device produces an ok report ---");
{
	const report = buildSyncCheckReport(healthyLocal, healthyServer);
	assert(report.tone === "ok", "no findings → ok tone");
	assert(report.findings.length === 0, "no findings");
	assert(report.summary.includes("Healthy"), "summary states health");
}

console.log("\n--- Test 2: plugin older than room schema is an error ---");
{
	const report = buildSyncCheckReport(
		{
			...healthyLocal,
			storedSchemaVersion: 5,
			schemaError: "CRDT schema version 5 is newer than this plugin supports (v4).",
		},
		healthyServer,
	);
	assert(report.tone === "error", "schema refusal escalates to error");
	assert(
		report.findings.some((f) => f.code === "schema-plugin-older-than-room"),
		"finding names the plugin-older-than-room code",
	);
}

console.log("\n--- Test 3: plugin/server version skew findings ---");
{
	const pluginOlder = buildSyncCheckReport(
		healthyLocal,
		{
			...healthyServer,
			capabilities: {
				serverVersion: "0.9.0",
				minSchemaVersion: 4,
				maxSchemaVersion: 6,
				minPluginVersion: "1.14.0",
			},
		},
	);
	assert(
		pluginOlder.findings.some((f) => f.code === "schema-plugin-older-than-server"),
		"server max schema above client → plugin-older-than-server",
	);

	const serverOlder = buildSyncCheckReport(
		healthyLocal,
		{
			...healthyServer,
			capabilities: {
				serverVersion: "0.7.0",
				minSchemaVersion: 5,
				maxSchemaVersion: 5,
				minPluginVersion: "1.9.4",
			},
		},
	);
	assert(
		serverOlder.findings.some((f) => f.code === "schema-server-older-than-plugin"),
		"server min schema above client → server-older-than-plugin",
	);
}

console.log("\n--- Test 4: room echo mismatch is an error ---");
{
	const report = buildSyncCheckReport(healthyLocal, {
		...healthyServer,
		debug: {
			...healthyServer.debug!,
			roomId: "different-room",
			roomEchoMatches: false,
		},
	});
	assert(report.tone === "error", "echo mismatch escalates to error");
	assert(
		report.findings.some((f) => f.code === "room-echo-mismatch"),
		"finding names the echo mismatch",
	);
}

console.log("\n--- Test 5: stale room and frozen projection findings ---");
{
	const staleRoom = buildSyncCheckReport(
		{ ...healthyLocal, roomDivergenceKind: "stale-room-suspected", activePathCount: 781, localSyncableFileCount: 4040 },
		healthyServer,
	);
	assert(
		staleRoom.findings.some((f) => f.code === "stale-room-suspected" && f.tone === "warn"),
		"stale room produces a warn finding",
	);

	const stalled = buildSyncCheckReport(
		{
			...healthyLocal,
			roomDivergenceKind: "projection-stalled-suspected",
			activePathCount: 4100,
			localSyncableFileCount: 781,
			projectionGateReady: false,
		},
		healthyServer,
	);
	assert(
		stalled.findings.some((f) => f.code === "projection-stalled-suspected"),
		"projection stall produces a finding",
	);
	assert(
		!stalled.findings.some((f) => f.code === "projection-gate-closed"),
		"the dedicated stall finding suppresses the generic gate-closed one",
	);

	const gateClosedOnly = buildSyncCheckReport(
		{ ...healthyLocal, projectionGateReady: false },
		healthyServer,
	);
	assert(
		gateClosedOnly.findings.some((f) => f.code === "projection-gate-closed"),
		"closed gate alone still surfaces",
	);
}

console.log("\n--- Test 6: safety brake and server failure findings ---");
{
	const brake = buildSyncCheckReport(
		{
			...healthyLocal,
			safetyBrakeTriggered: true,
			blockedDivergenceCount: 42,
		},
		healthyServer,
	);
	assert(
		brake.findings.some((f) => f.code === "safety-brake-active"),
		"active brake produces a finding",
	);

	const unreachable = buildSyncCheckReport(healthyLocal, {
		capabilities: null,
		debug: null,
		error: "capabilities fetch failed (timeout)",
	});
	assert(
		unreachable.findings.some((f) => f.code === "server-unreachable"),
		"server failure produces a finding, not a crash",
	);
	assert(unreachable.tone === "warn", "server failure alone stays warn");
}

console.log("\n--- Test 7: cold room and path-count drift are informational ---");
{
	const cold = buildSyncCheckReport(healthyLocal, {
		...healthyServer,
		debug: {
			roomId: "vault-x",
			roomEchoMatches: true,
			documentLoaded: false,
			activePathCount: null,
			schemaVersion: null,
			persistenceHealthy: null,
		},
	});
	assert(
		cold.findings.some((f) => f.code === "server-cold-room" && f.tone === "info"),
		"cold room is informational",
	);

	const drift = buildSyncCheckReport(healthyLocal, {
		...healthyServer,
		debug: {
			...healthyServer.debug!,
			activePathCount: 1400,
		},
	});
	assert(
		drift.findings.some((f) => f.code === "room-path-count-mismatch" && f.tone === "info"),
		"server/local count drift is informational",
	);
	assert(drift.tone === "info", "info-only findings keep the report informational");
}

console.log("\n--- Test 8: worst finding sets the overall tone ---");
{
	const report = buildSyncCheckReport(
		{
			...healthyLocal,
			idbError: true,
			roomDivergenceKind: "stale-room-suspected",
			activePathCount: 781,
			localSyncableFileCount: 4040,
		},
		{ capabilities: null, debug: null, error: "timeout" },
	);
	assert(report.tone === "error", "error outranks warn and info");
	assert(report.findings.length >= 3, "multiple causes coexist in one report");
}

console.log("\n--- Results ---");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
