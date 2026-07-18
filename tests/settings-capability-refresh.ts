import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SettingsCapabilityRefreshSession } from "../src/settings/settingsCapabilityRefresh";

const session = new SettingsCapabilityRefreshSession();

const firstGeneration = session.beginDisplay(true);
assert.equal(firstGeneration, 1, "configured settings entry requests one capability refresh");
assert.equal(session.isInFlight, true, "entry refresh is exposed to the settings UI");
assert.equal(session.isVisible, true, "display marks the settings session visible");
assert.equal(
	session.beginDisplay(true),
	null,
	"rerendering the visible settings tab does not request another refresh",
);
assert.equal(session.complete(firstGeneration!), true, "current entry completion may rerender the tab");
assert.equal(session.isInFlight, false, "completion clears the visible loading state");
assert.equal(
	session.beginDisplay(true),
	null,
	"completion rerender remains request-free instead of forming a polling loop",
);

session.endDisplay();
assert.equal(session.isVisible, false, "hide marks the settings session invisible");
const secondGeneration = session.beginDisplay(true);
assert.notEqual(secondGeneration, null, "leaving and re-entering settings permits one fresh probe");
assert.notEqual(secondGeneration, firstGeneration, "each visible session has a distinct generation");

session.endDisplay();
const unconfiguredSession = new SettingsCapabilityRefreshSession();
assert.equal(
	unconfiguredSession.beginDisplay(false),
	null,
	"an incomplete setup does not make an unnecessary network request",
);
const configuredGeneration = unconfiguredSession.beginDisplay(true);
assert.notEqual(
	configuredGeneration,
	null,
	"a server configured while settings remain visible receives one probe",
);

const staleSession = new SettingsCapabilityRefreshSession();
const staleGeneration = staleSession.beginDisplay(true)!;
staleSession.endDisplay();
let staleRedisplays = 0;
if (staleSession.isVisible) {
	staleRedisplays += 1;
	staleSession.beginDisplay(true);
}
assert.equal(
	staleRedisplays,
	0,
	"an async UI completion after hide cannot redisplay the hidden settings tab",
);
const reopenedGeneration = staleSession.beginDisplay(true)!;
assert.equal(
	staleSession.complete(staleGeneration),
	false,
	"a request finishing after settings close cannot reopen or rerender the tab",
);
assert.equal(
	staleSession.isInFlight,
	true,
	"a stale completion cannot clear the loading state of a newly reopened session",
);
assert.equal(
	staleSession.complete(reopenedGeneration),
	true,
	"the current reopened session completion can rerender normally",
);

const settingsSource = readFileSync("src/settings/settingsTab.ts", "utf8");
assert.match(
	settingsSource,
	/refreshServerCapabilities\("settings-open"\)/,
	"settings entry is wired to the explicit one-shot capability refresh",
);
assert.doesNotMatch(
	settingsSource,
	/setInterval\s*\(/,
	"settings capability detection does not use background polling",
);
assert.equal(
	settingsSource.match(/this\.display\(\)/g)?.length,
	1,
	"all settings rerenders flow through the single visibility-guarded helper",
);
assert.match(
	settingsSource,
	/private redisplayIfVisible\(\): void \{[\s\S]*?capabilityRefreshSession\.isVisible[\s\S]*?this\.display\(\)/,
	"the remaining direct display call is guarded by visible session state",
);

console.log("settings capability refresh tests passed");
