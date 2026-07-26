import assert from "node:assert/strict";
import {
	ProviderPolicySettlementCoordinator,
	type ProviderPolicySettlementRequest,
} from "../src/runtime/providerPolicySettlementCoordinator";

let releaseFirst!: () => void;
let firstStarted!: () => void;
const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
const started = new Promise<void>((resolve) => { firstStarted = resolve; });
const completed: number[] = [];

const coordinator = new ProviderPolicySettlementCoordinator(async (request) => {
	if (request.generation === 1) {
		firstStarted();
		await firstGate;
	}
	completed.push(request.generation);
});

const owner = {};
const first: ProviderPolicySettlementRequest = {
	vaultSync: owner,
	generation: 1,
	reason: "generation-1",
};
const second: ProviderPolicySettlementRequest = {
	vaultSync: owner,
	generation: 2,
	reason: "generation-2",
};

const firstRun = coordinator.request(first);
await started;
const secondRun = coordinator.request(second);
releaseFirst();
await Promise.all([firstRun, secondRun]);

assert.deepEqual(
	completed,
	[1, 2],
	"a newer generation requested during an older disk read is rerun after it",
);

console.log("PASS provider policy settlement coordinator");
