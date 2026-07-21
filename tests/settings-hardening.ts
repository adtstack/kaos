import {
	attachmentSizeCapKB,
	DEFAULT_SETTINGS,
	EXTERNAL_EDIT_POLICY_SAFETY_MIGRATION_VERSION,
	MAX_ATTACHMENT_SIZE_KB,
	MAX_ATTACHMENT_CONCURRENCY,
	MAX_TEXT_FILE_SIZE_KB,
	persistSettingsMutation,
	readVaultSyncSettings,
	SettingsMutationQueue,
} from "../src/settings/settingsStore";

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

console.log("\n--- Test 1: attachment max is capped to the server upload contract ---");
{
	const { settings, migrated } = readVaultSyncSettings({
		maxAttachmentSizeKB: MAX_ATTACHMENT_SIZE_KB + 1,
	});
	assert(settings.maxAttachmentSizeKB === MAX_ATTACHMENT_SIZE_KB, "oversized attachment setting is capped");
	assert(migrated, "oversized attachment setting marks settings as migrated");
}

console.log("\n--- Test 2: invalid attachment max falls back inside the valid range ---");
{
	const { settings, migrated } = readVaultSyncSettings({
		maxAttachmentSizeKB: -10,
	});
	assert(settings.maxAttachmentSizeKB >= 1, "invalid attachment setting is repaired to a positive value");
	assert(settings.maxAttachmentSizeKB <= MAX_ATTACHMENT_SIZE_KB, "repaired attachment setting stays under cap");
	assert(migrated, "invalid attachment setting marks settings as migrated");
}

console.log("\n--- Test 3: valid attachment max is preserved ---");
{
	const { settings, migrated } = readVaultSyncSettings({
		attachmentSyncExplicitlyConfigured: true,
		maxAttachmentSizeKB: 4096,
	});
	assert(settings.maxAttachmentSizeKB === 4096, "valid attachment setting is preserved");
	assert(!migrated, "valid attachment setting does not force migration");
}

console.log("\n--- Test 4: server capability can lower the effective attachment cap ---");
{
	assert(
		attachmentSizeCapKB(5 * 1024 * 1024) === 5 * 1024,
		"5 MB server capability lowers effective attachment cap to 5120 KB",
	);
	assert(
		attachmentSizeCapKB(50 * 1024 * 1024) === MAX_ATTACHMENT_SIZE_KB,
		"larger server capability does not raise the client above the built-in ceiling",
	);
	assert(
		attachmentSizeCapKB(null) === MAX_ATTACHMENT_SIZE_KB,
		"missing server capability falls back to built-in ceiling",
	);
}

console.log("\n--- Test 5: external edits default to closed files only ---");
{
	assert(
		DEFAULT_SETTINGS.externalEditPolicy === "closed-only",
		"default external edit policy protects open editor files",
	);
	const { settings } = readVaultSyncSettings(undefined);
	assert(
		settings.externalEditPolicy === "closed-only",
		"loaded empty settings inherit the closed-only policy",
	);
}

console.log("\n--- Test 6: remote typing advisory is enabled by default ---");
{
	assert(
		DEFAULT_SETTINGS.remoteTypingGuardEnabled,
		"default settings warn about active remote typing",
	);
	const { settings } = readVaultSyncSettings(undefined);
	assert(
		settings.remoteTypingGuardEnabled,
		"loaded empty settings inherit the remote typing advisory",
	);
}

console.log("\n--- Test 7: old always external edit policy is migrated to closed-only ---");
{
	const { settings, migrated } = readVaultSyncSettings({
		attachmentSyncExplicitlyConfigured: true,
		externalEditPolicy: "always",
	});
	assert(
		settings.externalEditPolicy === "closed-only",
		"legacy always policy is migrated to closed-only",
	);
	assert(
		settings.externalEditPolicySafetyMigrationVersion === EXTERNAL_EDIT_POLICY_SAFETY_MIGRATION_VERSION,
		"legacy always migration records the safety migration marker",
	);
	assert(migrated, "legacy always policy marks settings as migrated");
}

console.log("\n--- Test 8: explicit post-migration always policy is preserved ---");
{
	const { settings, migrated } = readVaultSyncSettings({
		attachmentSyncExplicitlyConfigured: true,
		externalEditPolicy: "always",
		externalEditPolicySafetyMigrationVersion: EXTERNAL_EDIT_POLICY_SAFETY_MIGRATION_VERSION,
	});
	assert(
		settings.externalEditPolicy === "always",
		"post-migration explicit always policy is preserved",
	);
	assert(!migrated, "post-migration explicit always policy does not re-migrate");
}

console.log("\n--- Test 9: invalid external edit policy falls back to closed-only ---");
{
	const { settings, migrated } = readVaultSyncSettings({
		attachmentSyncExplicitlyConfigured: true,
		externalEditPolicy: "surprise" as never,
	});
	assert(
		settings.externalEditPolicy === "closed-only",
		"invalid external edit policy is repaired to closed-only",
	);
	assert(migrated, "invalid external edit policy marks settings as migrated");

	const repairedNull = readVaultSyncSettings({
		attachmentSyncExplicitlyConfigured: true,
		externalEditPolicy: null as never,
		externalEditPolicySafetyMigrationVersion: EXTERNAL_EDIT_POLICY_SAFETY_MIGRATION_VERSION,
	});
	assert(
		repairedNull.settings.externalEditPolicy === "closed-only",
		"null external edit policy cannot bypass the closed-file safety default",
	);
	assert(repairedNull.migrated, "null external edit policy marks settings as migrated");
}

console.log("\n--- Test 10: persisted transfer concurrency is a finite 1..5 integer ---");
for (const [input, expected] of [
	[0, 1],
	[-4, 1],
	[2.9, 2],
	[99, MAX_ATTACHMENT_CONCURRENCY],
	[Number.NaN, DEFAULT_SETTINGS.attachmentConcurrency],
	[Number.POSITIVE_INFINITY, DEFAULT_SETTINGS.attachmentConcurrency],
] as const) {
	const { settings, migrated } = readVaultSyncSettings({
		attachmentSyncExplicitlyConfigured: true,
		attachmentConcurrency: input,
	});
	assert(
		settings.attachmentConcurrency === expected,
		`attachment concurrency ${String(input)} is repaired to ${expected}`,
	);
	assert(migrated, `attachment concurrency ${String(input)} marks settings as migrated`);
}

console.log("\n--- Test 11: persisted text size cannot disable or overflow the guard ---");
for (const [input, expected] of [
	[0, 1],
	[-1, 1],
	[2.9, 2],
	[MAX_TEXT_FILE_SIZE_KB + 1, MAX_TEXT_FILE_SIZE_KB],
	[Number.NaN, DEFAULT_SETTINGS.maxFileSizeKB],
] as const) {
	const { settings, migrated } = readVaultSyncSettings({
		attachmentSyncExplicitlyConfigured: true,
		maxFileSizeKB: input,
	});
	assert(settings.maxFileSizeKB === expected, `text size ${String(input)} is repaired to ${expected}`);
	assert(migrated, `text size ${String(input)} marks settings as migrated`);
}

console.log("\n--- Test 12: malformed persisted scalar types fall back safely ---");
{
	const { settings, migrated } = readVaultSyncSettings({
		attachmentSyncExplicitlyConfigured: true,
		host: 7 as never,
		debug: "yes" as never,
		qaTraceMode: "everything" as never,
	});
	assert(settings.host === DEFAULT_SETTINGS.host, "non-string host cannot reach runtime trim calls");
	assert(settings.debug === DEFAULT_SETTINGS.debug, "non-boolean debug value is repaired");
	assert(settings.qaTraceMode === DEFAULT_SETTINGS.qaTraceMode, "unknown trace mode is repaired");
	assert(migrated, "malformed scalar settings mark settings as migrated");
}

console.log("\n--- Test 13: failed persistence rolls shared settings back in place ---");
{
	const settings = { ...DEFAULT_SETTINGS, host: "https://old.example", token: "old-token" };
	const identity = settings;
	let rollbackCalled = false;
	let rejected = false;
	try {
		await persistSettingsMutation(
			settings,
			(current) => {
				current.host = "https://new.example";
				current.token = "new-token";
			},
			async () => { throw new Error("disk full"); },
			() => { rollbackCalled = true; },
		);
	} catch {
		rejected = true;
	}
	assert(rejected, "failed settings persistence rejects the update");
	assert(settings === identity, "rollback preserves the shared settings object identity");
	assert(settings.host === "https://old.example" && settings.token === "old-token", "failed credentials are removed from memory");
	assert(rollbackCalled, "companion persisted-state snapshot is restored");
}

console.log("\n--- Test 14: mutator exceptions restore deleted and newly added keys ---");
{
	const settings = {
		...DEFAULT_SETTINGS,
		host: "https://old.example",
		deviceName: "phone",
	};
	const record = settings as unknown as Record<string, unknown>;
	let persistCalled = false;
	let rollbackCalled = false;
	let rejected = false;
	try {
		await persistSettingsMutation(
			settings,
			(current) => {
				current.host = "https://partial.example";
				delete (current as Partial<typeof current>).deviceName;
				(current as unknown as Record<string, unknown>).transientCredential = "must-not-leak";
				Object.defineProperty(current, "hiddenTransientCredential", {
					configurable: true,
					value: "must-not-leak-either",
				});
				throw new Error("invalid edit");
			},
			async () => { persistCalled = true; },
			() => { rollbackCalled = true; },
		);
	} catch {
		rejected = true;
	}
	assert(rejected, "mutator exception rejects the transaction");
	assert(!persistCalled, "mutator exception never starts durable persistence");
	assert(rollbackCalled, "mutator exception invokes companion-state rollback");
	assert(settings.host === "https://old.example", "partially changed fields are restored");
	assert(settings.deviceName === "phone", "deleted settings fields are restored");
	assert(!Object.prototype.hasOwnProperty.call(record, "transientCredential"), "new keys are removed on rollback");
	assert(
		!Object.prototype.hasOwnProperty.call(record, "hiddenTransientCredential"),
		"new non-enumerable keys are removed on rollback",
	);
}

console.log("\n--- Test 15: overlapping saves serialize through rollback and runtime apply ---");
{
	const queue = new SettingsMutationQueue();
	const settings = { ...DEFAULT_SETTINGS, host: "https://old.example" };
	let diskHost = settings.host;
	let runtimeHost = settings.host;
	let rejectFirstPersist: (reason: Error) => void = () => undefined;
	const firstPersist = new Promise<void>((_resolve, reject) => {
		rejectFirstPersist = reject;
	});

	const first = queue.run(() => persistSettingsMutation(
		settings,
		(current) => { current.host = "https://first.example"; },
		async () => {
			await firstPersist;
			diskHost = settings.host;
			runtimeHost = settings.host;
		},
	));
	const firstRejected = first.then(
		() => false,
		() => true,
	);

	let secondMutatorRan = false;
	let secondSawHost = "";
	const second = queue.run(() => persistSettingsMutation(
		settings,
		(current) => {
			secondMutatorRan = true;
			secondSawHost = current.host;
			current.host = "https://second.example";
		},
		async () => {
			diskHost = settings.host;
			runtimeHost = settings.host;
		},
	));

	await Promise.resolve();
	assert(settings.host === "https://first.example", "first transaction owns shared memory while its save is pending");
	assert(!secondMutatorRan, "later mutator waits for the full earlier transaction");

	rejectFirstPersist(new Error("disk full"));
	assert(await firstRejected, "failed first save rejects its own caller");
	await second;

	assert(secondSawHost === "https://old.example", "later mutator starts from the rolled-back settings snapshot");
	assert(settings.host === "https://second.example", "successful later edit becomes the in-memory value");
	assert(diskHost === settings.host, "durable settings match memory after the queued recovery");
	assert(runtimeHost === settings.host, "runtime settings match memory after the queued recovery");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
