import {
	evaluateRoomDivergence,
	PROJECTION_STALL_MIN_GAP,
	ROOM_DIVERGENCE_MIN_LOCAL_FILES,
	ROOM_DIVERGENCE_RATIO,
} from "../src/runtime/roomDivergencePolicy";
import {
	collectDashboardAttention,
	getDashboardAttentionTotalCount,
} from "../src/dashboard/dashboardData";

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

const baseInput = {
	providerSynced: true,
	crdtActivePathCount: 100,
	localSyncableFileCount: 100,
	projectionGateReady: true,
};

console.log("\n--- Test 1: converged equal counts are healthy ---");
{
	assert(
		evaluateRoomDivergence(baseInput).kind === "ok",
		"equal counts with an open gate → ok",
	);
	assert(
		evaluateRoomDivergence({ ...baseInput, providerSynced: false }).kind === "ok",
		"never evaluated before provider sync converges",
	);
}

console.log("\n--- Test 2: local >> CRDT after convergence → stale room ---");
{
	const decision = evaluateRoomDivergence({
		...baseInput,
	 crdtActivePathCount: 781,
		localSyncableFileCount: 4040,
	});
	assert(decision.kind === "stale-room-suspected", "781 vs 4,040 trips the stale-room signal");
	if (decision.kind === "stale-room-suspected") {
		assert(decision.reason.includes("781"), "reason quotes the room's file count");
		assert(decision.reason.includes("4040"), "reason quotes the local file count");
	}
}

console.log("\n--- Test 3: stale-room guards ---");
{
	assert(
		evaluateRoomDivergence({
			...baseInput,
			crdtActivePathCount: 0,
			localSyncableFileCount: 5000,
		}).kind === "ok",
		"empty room (fresh room being seeded) does not trip",
	);
	assert(
		evaluateRoomDivergence({
			...baseInput,
			crdtActivePathCount: 90,
			localSyncableFileCount: 150,
		}).kind === "ok",
		"small vaults below the floor stay quiet",
	);
	assert(
		evaluateRoomDivergence({
			...baseInput,
			crdtActivePathCount: 200,
			localSyncableFileCount: 500,
		}).kind === "ok",
		"sub-ratio divergence (2.5x) stays quiet",
	);
	const boundary = evaluateRoomDivergence({
		...baseInput,
		crdtActivePathCount: 100,
		localSyncableFileCount: ROOM_DIVERGENCE_MIN_LOCAL_FILES * ROOM_DIVERGENCE_RATIO,
	});
	assert(boundary.kind === "stale-room-suspected", "exact ratio boundary trips");
}

console.log("\n--- Test 4: CRDT >> local with closed gate → projection stall ---");
{
	const decision = evaluateRoomDivergence({
		...baseInput,
		crdtActivePathCount: 4100,
		localSyncableFileCount: 781,
		projectionGateReady: false,
	});
	assert(
		decision.kind === "projection-stalled-suspected",
		"781-on-disk vs 4,100-in-room with a closed gate trips the stall signal",
	);
	assert(
		evaluateRoomDivergence({
			...baseInput,
			crdtActivePathCount: 4100,
			localSyncableFileCount: 781,
			projectionGateReady: true,
		}).kind === "ok",
		"same gap with an open gate stays quiet (legit in-flight download)",
	);
	assert(
		evaluateRoomDivergence({
			...baseInput,
			crdtActivePathCount: 1000,
			localSyncableFileCount: 1000 - PROJECTION_STALL_MIN_GAP,
			projectionGateReady: false,
		}).kind === "projection-stalled-suspected",
		"exact gap boundary trips",
	);
}

console.log("\n--- Test 5: dashboard attention surfaces room divergence ---");
{
	const suspicion = evaluateRoomDivergence({
		...baseInput,
		crdtActivePathCount: 781,
		localSyncableFileCount: 4040,
	});
	const ok = evaluateRoomDivergence(baseInput);
	const emptyInput = {
		app: {} as never,
		preservedUnresolvedEntries: [],
		frontmatterQuarantineEntries: [],
		reconciliationState: {
			unresolvedStructuralChangePaths: [] as string[],
			unresolvedStructuralChangeSample: [],
			unresolvedStructuralChangeGroupCount: 0,
			blockedDivergenceCount: 0,
		},
		remoteProjectionPolicyError: null,
	};

	const items = collectDashboardAttention({
		...emptyInput,
		roomDivergence: suspicion,
	});
	assert(
		items.some((item) => item.kind === "room-divergence" && item.tone === "warn"),
		"attention list includes a warn room-divergence item",
	);
	assert(
		collectDashboardAttention({ ...emptyInput, roomDivergence: ok }).every(
			(item) => item.kind !== "room-divergence",
		),
		"healthy verdict adds no attention item",
	);
	assert(
		getDashboardAttentionTotalCount({ ...emptyInput, roomDivergence: suspicion }) === 1,
		"attention count includes the room-divergence item",
	);
	assert(
		getDashboardAttentionTotalCount({ ...emptyInput, roomDivergence: ok }) === 0,
		"healthy verdict does not change the attention count",
	);
}

console.log("\n--- Results ---");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
