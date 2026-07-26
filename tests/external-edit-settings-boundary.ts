import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as settingsStoreModule from "../src/settings/settingsStore";

const {
	DEFAULT_SETTINGS,
	SettingsStore,
	readVaultSyncSettings,
} = settingsStoreModule;

const compatibilityExports = settingsStoreModule as typeof settingsStoreModule & {
	EXTERNAL_EDIT_POLICY_COMPAT_VALUE?: unknown;
	EXTERNAL_EDIT_POLICY_SAFETY_MIGRATION_VERSION?: unknown;
};

assert.equal(
	compatibilityExports.EXTERNAL_EDIT_POLICY_COMPAT_VALUE,
	"always",
	"the serialized compatibility policy remains the downgrade-safe always value",
);
assert.equal(
	compatibilityExports.EXTERNAL_EDIT_POLICY_SAFETY_MIGRATION_VERSION,
	1,
	"the downgrade marker remains exactly 1",
);

assert.equal(
	Object.hasOwn(DEFAULT_SETTINGS, "externalEditPolicy"),
	false,
	"live default settings expose no external edit policy",
);
assert.equal(
	Object.hasOwn(DEFAULT_SETTINGS, "externalEditPolicySafetyMigrationVersion"),
	false,
	"live default settings expose no serialized migration marker",
);

for (const externalEditPolicy of [
	"closed-only",
	"never",
	"invalid",
	null,
	undefined,
] as const) {
	const result = readVaultSyncSettings({
		attachmentSyncExplicitlyConfigured: true,
		externalEditPolicy,
		externalEditPolicySafetyMigrationVersion: 1,
	} as never);
	assert.equal(Object.hasOwn(result.settings, "externalEditPolicy"), false);
	assert.equal(
		Object.hasOwn(result.settings, "externalEditPolicySafetyMigrationVersion"),
		false,
	);
	assert.equal(result.migrated, true);
}

const canonical = readVaultSyncSettings({
	attachmentSyncExplicitlyConfigured: true,
	externalEditPolicy: "always",
	externalEditPolicySafetyMigrationVersion: 1,
} as never);
assert.equal(Object.hasOwn(canonical.settings, "externalEditPolicy"), false);
assert.equal(
	Object.hasOwn(canonical.settings, "externalEditPolicySafetyMigrationVersion"),
	false,
);
assert.equal(canonical.migrated, false);

let persisted: Record<string, unknown> | null = null;
const store = new SettingsStore({
	loadData: async () => ({}),
	saveData: async (value) => {
		persisted = value as Record<string, unknown>;
	},
});
await store.save({
	externalEditPolicy: "never",
	externalEditPolicySafetyMigrationVersion: 999,
	retainedPluginState: "kept",
} as never);
assert.equal(persisted?.externalEditPolicy, "always");
assert.equal(persisted?.externalEditPolicySafetyMigrationVersion, 1);
assert.equal(persisted?.retainedPluginState, "kept");

const withSettings = store.withSettings({
	externalEditPolicy: "closed-only",
	externalEditPolicySafetyMigrationVersion: 999,
	retainedPluginState: "kept",
} as never, canonical.settings) as unknown as Record<string, unknown>;
assert.equal(withSettings.externalEditPolicy, "always");
assert.equal(withSettings.externalEditPolicySafetyMigrationVersion, 1);
assert.equal(withSettings.retainedPluginState, "kept");

assert.equal(
	compatibilityExports.EXTERNAL_EDIT_POLICY_COMPAT_VALUE === "always" &&
		compatibilityExports.EXTERNAL_EDIT_POLICY_SAFETY_MIGRATION_VERSION !== 1,
	false,
	"KAOS 1.8.16 downgrade must not remigrate always to closed-only",
);

const behaviorPath = new URL("../src/sync/externalEditBehavior.ts", import.meta.url);
assert.equal(existsSync(behaviorPath), true, "the single production behavior fact exists");
if (existsSync(behaviorPath)) {
	assert.match(
		readFileSync(behaviorPath, "utf8"),
		/export const EXTERNAL_EDIT_BEHAVIOR\s*=\s*[\r\n\t ]*"include-open-files-safely" as const;/,
	);
}

for (const relativePath of [
	"../src/settings.ts",
	"../src/settings/settingsTab.ts",
	"../src/runtime/runtimeConfig.ts",
] as const) {
	const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
	assert.equal(
		source.includes("externalEditPolicy"),
		false,
		`${relativePath} contains no live external edit policy surface`,
	);
}

console.log("external edit settings boundary: PASS");
