import assert from "node:assert/strict";
import {
	GUIDED_SERVER_UPDATE_TIMEOUT_MS,
	GUIDED_SERVER_UPDATE_USER_ACTION_GRACE_MS,
	evaluateGuidedServerUpdateState,
	readPersistedGuidedServerUpdateState,
} from "../src/runtime/guidedServerUpdate";

const startedAt = 1_000_000;
const pending = {
	status: "waiting-for-user" as const,
	targetVersion: "0.5.0",
	startedAt,
	updateActionUrl: "https://github.com/example/kaos/actions/workflows/kaos-ops.yml",
};

assert.deepEqual(readPersistedGuidedServerUpdateState(pending), pending, "valid state is accepted");
assert.equal(readPersistedGuidedServerUpdateState({ ...pending, status: "idle" }), null, "idle state is not persisted");
assert.equal(readPersistedGuidedServerUpdateState({ ...pending, targetVersion: "" }), null, "blank target rejected");
assert.equal(readPersistedGuidedServerUpdateState({ ...pending, startedAt: 0 }), null, "invalid startedAt rejected");
assert.equal(readPersistedGuidedServerUpdateState({ ...pending, updateActionUrl: "" }), null, "blank action URL rejected");

const beforeGrace = evaluateGuidedServerUpdateState(
	pending,
	"0.4.1",
	startedAt + GUIDED_SERVER_UPDATE_USER_ACTION_GRACE_MS - 1,
);
assert.equal(beforeGrace.status, "waiting-for-user", "keeps waiting-for-user before grace window");
assert.equal(beforeGrace.changed, false, "no transition before grace window");

const afterGrace = evaluateGuidedServerUpdateState(
	pending,
	"0.4.1",
	startedAt + GUIDED_SERVER_UPDATE_USER_ACTION_GRACE_MS,
);
assert.equal(afterGrace.status, "waiting-for-deploy", "moves to deploy wait after grace window");
assert.equal(afterGrace.changed, true, "grace transition is persisted");

const completed = evaluateGuidedServerUpdateState(pending, "0.5.0", startedAt + 1);
assert.equal(completed.status, "updated", "target version completes monitor");
assert.equal(completed.changed, true, "completion transition is persisted");

const newerCompleted = evaluateGuidedServerUpdateState(pending, "0.6.0", startedAt + 1);
assert.equal(newerCompleted.status, "updated", "newer server version also completes monitor");

const timedOut = evaluateGuidedServerUpdateState(
	pending,
	"0.4.1",
	startedAt + GUIDED_SERVER_UPDATE_TIMEOUT_MS,
);
assert.equal(timedOut.status, "timed-out", "timeout is reported when target never appears");
assert.equal(timedOut.changed, true, "timeout transition is persisted");

console.log("guided server update state tests passed");
