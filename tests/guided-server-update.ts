import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	GUIDED_SERVER_UPDATE_TIMEOUT_MS,
	GUIDED_SERVER_UPDATE_USER_ACTION_GRACE_MS,
	evaluateGuidedServerUpdateState,
	readPersistedGuidedServerUpdateState,
} from "../src/runtime/guidedServerUpdate";
import {
	buildGithubOpsBootstrapWorkflowYaml,
	CapabilityUpdateService,
	GITHUB_OPS_WORKFLOW_FILENAME,
	GITHUB_OPS_WORKFLOW_PATH,
} from "../src/runtime/capabilityUpdateService";

const startedAt = 1_000_000;
const pending = {
	status: "waiting-for-user" as const,
	targetVersion: "0.5.0",
	startedAt,
	updateActionUrl: "https://github.com/example/kaos/actions/workflows/kaos-ops-v3.yml",
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

const workflowCases = [
	{
		label: "bootstrap workflow",
		source: buildGithubOpsBootstrapWorkflowYaml(),
		envExpression: "${{ github.event.inputs.allow_migration_update }}",
	},
	{
		label: "legacy server template",
		source: readFileSync("server/.github/workflows/kaos-ops.yml", "utf8"),
		envExpression: "${{ github.event.inputs.allow_migration_update }}",
	},
	{
		label: "legacy-safe versioned server template",
		source: readFileSync("server/.github/workflows/kaos-ops-v3.yml", "utf8"),
		envExpression: "${{ github.event.inputs.allow_migration_update }}",
	},
	{
		label: "reusable public workflow",
		source: readFileSync(".github/workflows/kaos-ops-reusable.yml", "utf8"),
		envExpression: "${{ inputs.allow_migration_update }}",
	},
];

for (const workflow of workflowCases) {
	assert.match(
		workflow.source,
		/allow_migration_update:\s*[\s\S]*?default:\s*false/,
		`${workflow.label} exposes a fail-closed migration confirmation`,
	);
	assert.ok(
		workflow.source.includes(
			`KAOS_ALLOW_MIGRATION_UPDATE: ${workflow.envExpression}`,
		),
		`${workflow.label} passes the explicit confirmation to the updater`,
	);
}

const updateService = new CapabilityUpdateService({
	getSettings: () => ({
		updateRepoUrl: "https://github.com/example/deployment",
		updateRepoBranch: "main",
	}),
} as any);
assert.equal(
	updateService.buildServerUpdateUrl(),
	`https://github.com/example/deployment/actions/workflows/${GITHUB_OPS_WORKFLOW_FILENAME}`,
	"GitHub update action targets the collision-free v3 workflow",
);
const bootstrapUrl = updateService.buildGithubUpdaterBootstrapUrl();
assert.ok(bootstrapUrl, "GitHub updater bootstrap URL is available");
const parsedBootstrapUrl = new URL(bootstrapUrl!);
assert.equal(
	parsedBootstrapUrl.searchParams.get("filename"),
	GITHUB_OPS_WORKFLOW_PATH,
	"bootstrap creates the versioned workflow without replacing legacy kaos-ops.yml",
);
assert.match(
	parsedBootstrapUrl.searchParams.get("value") ?? "",
/^name: KAOS Server Ops v3/m,
	"bootstrap content is the legacy-safe v3 workflow",
);
assert.match(
	parsedBootstrapUrl.searchParams.get("value") ?? "",
/Refresh updater from release[\s\S]*?KAOS_RELEASE_VERSION[\s\S]*?KAOS_RELEASE_TOKEN[\s\S]*?kaos-server-bootstrap\.zip[\s\S]*?BOOTSTRAP_URL[\s\S]*?Authorization: Bearer[\s\S]*?unzip -p/,
	"bootstrap workflow refreshes the updater with private-release authentication before every update run",
);

const settingsSource = readFileSync("src/settings/settingsTab.ts", "utf8");
const migrationUiStart = settingsSource.indexOf(
	"if (updateState.serverUpdateAvailable && updateState.migrationRequired)",
);
const migrationUiEnd = settingsSource.indexOf(
	"} else if (updateActionUrl && updateState.guidedServerUpdateAvailable)",
	migrationUiStart,
);
const migrationUi = settingsSource.slice(migrationUiStart, migrationUiEnd);
assert.ok(
	migrationUi.indexOf("1. Create updater v3") >= 0
		&& migrationUi.indexOf("1. Create updater v3")
			< migrationUi.indexOf("2. After commit, run migration"),
	"migration settings present workflow creation before execution",
);
assert.match(
	settingsSource,
	/Plugin-first migration: sync pauses until you create and commit updater v3/,
	"migration settings explain the intentional compatibility pause",
);

console.log("guided server update state tests passed");
