import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import {
	IndexedDbBlobSettledRefStore,
	buildBlobSettledRefStoreKey,
	type BlobSettledRefScope,
} from "../src/sync/indexedDbBlobSettledRefStore";
import type {
	BlobSettlementStageCache,
	BlobSettledRefCache,
	BlobSettledSourceVersionCache,
} from "../src/sync/blobSync";
import type { BlobRef } from "../src/types";

const SCOPE: BlobSettledRefScope = {
	host: "https://sync.example",
	vaultId: "vault-a",
	localDeviceId: "device-a",
};
const REF_A: BlobRef = {
	hash: "a".repeat(64),
	size: 10,
	priorHashes: ["b".repeat(64), "c".repeat(64)],
};
const REF_B: BlobRef = { hash: "d".repeat(64), size: 20 };
const SOURCE_VERSION_A = "101:7";
const SOURCE_VERSION_B = "202:9";

function uniqueDbName(label: string): string {
	return `kaos-blob-settled-ref-${label}-${Date.now()}-${Math.random()}`;
}

function jsonValue<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(dbName);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("test database open failed"));
	});
}

async function putRaw(dbName: string, key: string, value: unknown): Promise<void> {
	const db = await openDatabase(dbName);
	await new Promise<void>((resolve, reject) => {
		const transaction = db.transaction("settledRefCaches", "readwrite");
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("test write failed"));
		transaction.onabort = () => reject(transaction.error ?? new Error("test write aborted"));
		transaction.objectStore("settledRefCaches").put(value, key);
	});
	db.close();
}

function persisted(entries: unknown[], scope: BlobSettledRefScope = SCOPE): unknown {
	return { schema: 1, scope, entries };
}

function persistedV2(
	entries: unknown[],
	legacyMissingPaths: unknown[] = [],
	scope: BlobSettledRefScope = SCOPE,
): unknown {
	return {
		schema: 2,
		scope,
		entries,
		migration: { status: "initialized", legacyMissingPaths },
	};
}

function persistedV3(
	entries: unknown[],
	stages: unknown[] = [],
	legacyMissingPaths: unknown[] = [],
	scope: BlobSettledRefScope = SCOPE,
): unknown {
	return {
		schema: 3,
		scope,
		entries,
		stages,
		migration: { status: "initialized", legacyMissingPaths },
	};
}

console.log("\n--- IndexedDB blob settled refs: exact scope keys ---");
{
	assert.equal(
		buildBlobSettledRefStoreKey(SCOPE),
		'kaos-blob-settled-v1:["https://sync.example","vault-a","device-a"]',
	);
	assert.notEqual(
		buildBlobSettledRefStoreKey({ host: "a:b", vaultId: "c", localDeviceId: "d" }),
		buildBlobSettledRefStoreKey({ host: "a", vaultId: "b:c", localDeviceId: "d" }),
		"tuple encoding must not permit delimiter collisions",
	);
	assert.throws(
		() => buildBlobSettledRefStoreKey({ ...SCOPE, localDeviceId: "" }),
		/scope requires/i,
	);
}

console.log("\n--- IndexedDB blob settled refs: normalized durable round trip ---");
{
	const dbName = uniqueDbName("round-trip");
	const store = new IndexedDbBlobSettledRefStore(SCOPE, indexedDB, dbName);
	assert.deepEqual(
		await store.loadWithStatus(),
		{
			cache: {},
			sourceVersions: {},
			stages: {},
			status: "missing",
			migrationStatus: "uninitialized",
			legacyMissingPaths: [],
		},
		"a never-persisted scope is distinguishable from corrupt authority",
	);
	const cache: BlobSettledRefCache = {
		["./assets\\cafe\u0301.png"]: REF_A,
		["__proto__"]: REF_B,
	};
	const sourceVersions: BlobSettledSourceVersionCache = Object.fromEntries([
		["assets/café.png", SOURCE_VERSION_A],
		["__proto__", SOURCE_VERSION_B],
	]);
	const stages: BlobSettlementStageCache = {
		["./assets\\pending-download.png"]: {
			stageId: "download-stage-1",
			kind: "download",
			ref: REF_A,
			sourceVersion: SOURCE_VERSION_A,
			stagedAt: 1_000,
		},
		"assets/pending-upload.png": {
			stageId: "upload-stage-1",
			kind: "upload",
			ref: REF_B,
			stagedAt: 2_000,
		},
		"assets/pending-equality.png": {
			stageId: "equality-stage-1",
			kind: "equality",
			ref: REF_B,
			sourceVersion: SOURCE_VERSION_B,
			stagedAt: 3_000,
		},
		"assets/pending-rename.png": {
			stageId: "rename-stage-1",
			kind: "rename",
			ref: REF_A,
			sourceVersion: SOURCE_VERSION_A,
			stagedAt: 4_000,
		},
		"assets/pending-retire.png": {
			stageId: "retire-stage-1",
			kind: "retire",
			ref: REF_A,
			sourceVersion: SOURCE_VERSION_A,
			stagedAt: 5_000,
		},
	};
	await store.save(cache, { legacyMissingPaths: [], sourceVersions, stages });
	const loaded = await new IndexedDbBlobSettledRefStore(SCOPE, indexedDB, dbName).loadWithStatus();
	assert.equal(loaded.status, "loaded");
	assert.equal(loaded.migrationStatus, "initialized");
	assert.deepEqual(loaded.legacyMissingPaths, []);
	assert.deepEqual(
		jsonValue(loaded.sourceVersions),
		Object.fromEntries([
			["assets/café.png", SOURCE_VERSION_A],
			["__proto__", SOURCE_VERSION_B],
		]),
		"exact CRDT source versions survive beside only their settled cache keys",
	);
	assert.deepEqual(
		jsonValue(loaded.stages),
		{
			"assets/pending-download.png": stages["./assets\\pending-download.png"],
			"assets/pending-upload.png": stages["assets/pending-upload.png"],
			"assets/pending-equality.png": stages["assets/pending-equality.png"],
			"assets/pending-rename.png": stages["assets/pending-rename.png"],
			"assets/pending-retire.png": stages["assets/pending-retire.png"],
		},
		"every staged establishment kind round-trips with exact identity and source version",
	);
	const restored = loaded.cache;
	assert.deepEqual(
		jsonValue(restored),
		Object.fromEntries([
			["assets/café.png", REF_A],
			["__proto__", REF_B],
		]),
	);
	assert.equal(Object.getPrototypeOf(restored), Object.prototype);
	assert.equal(({} as { polluted?: boolean }).polluted, undefined);

	restored["assets/café.png"]!.hash = "e".repeat(64);
	restored["assets/café.png"]!.priorHashes!.push("f".repeat(64));
	loaded.stages["assets/pending-download.png"]!.stageId = "mutated-stage";
	loaded.stages["assets/pending-download.png"]!.ref.hash = "f".repeat(64);
	const restoredAgain = await store.loadWithStatus();
	assert.deepEqual(
		restoredAgain.cache["assets/café.png"],
		REF_A,
		"settled refs load as defensive structured clones",
	);
	assert.equal(
		restoredAgain.stages["assets/pending-download.png"]?.stageId,
		"download-stage-1",
		"stage identity cannot be mutated through a prior load result",
	);
	assert.deepEqual(
		restoredAgain.stages["assets/pending-download.png"]?.ref,
		REF_A,
		"stage refs load as defensive structured clones",
	);
}

console.log("\n--- IndexedDB blob settled refs: ref-less retirement is the only valid exception ---");
{
	const dbName = uniqueDbName("ref-less-retire");
	const store = new IndexedDbBlobSettledRefStore(SCOPE, indexedDB, dbName);
	const retireStages: BlobSettlementStageCache = {
		"assets/retired-without-ref.png": {
			stageId: "retire-without-ref",
			kind: "retire",
			sourceVersion: SOURCE_VERSION_A,
			stagedAt: 6_000,
		},
	};
	await store.save({}, { legacyMissingPaths: [], stages: retireStages });
	const loaded = await store.loadWithStatus();
	assert.deepEqual(
		jsonValue(loaded),
		{
			cache: {},
			sourceVersions: {},
			stages: retireStages,
			status: "loaded",
			migrationStatus: "initialized",
			legacyMissingPaths: [],
		},
		"schema-3 retirement stages round-trip without inventing a blob ref",
	);
	assert.equal(
		Object.hasOwn(loaded.stages["assets/retired-without-ref.png"]!, "ref"),
		false,
		"a ref-less retirement remains ref-less after persistence",
	);

	const refRequiredKinds = ["upload", "download", "equality", "rename"] as const;
	for (const [index, kind] of refRequiredKinds.entries()) {
		const path = `assets/ref-less-${kind}.png`;
		await assert.rejects(
			store.save({}, {
				legacyMissingPaths: [],
				stages: {
					[path]: {
						stageId: `ref-less-${kind}`,
						kind,
						stagedAt: 6_100 + index,
					},
				} as unknown as BlobSettlementStageCache,
			}),
			/invalid blob settlement stages/i,
			`${kind} stages cannot be saved without an exact ref`,
		);
	}
	assert.deepEqual(
		jsonValue(await store.loadWithStatus()),
		jsonValue(loaded),
		"rejected ref-less establishment saves preserve the prior retirement record atomically",
	);

	const rawDbName = uniqueDbName("ref-less-establishment-load");
	const rawStore = new IndexedDbBlobSettledRefStore(SCOPE, indexedDB, rawDbName);
	await rawStore.save({});
	const key = buildBlobSettledRefStoreKey(SCOPE);
	for (const [index, kind] of refRequiredKinds.entries()) {
		await putRaw(rawDbName, key, persistedV3([], [{
			path: `assets/ref-less-${kind}.png`,
			stageId: `raw-ref-less-${kind}`,
			kind,
			stagedAt: 6_200 + index,
		}]));
		assert.deepEqual(
			await rawStore.loadWithStatus(),
			{
				cache: {},
				sourceVersions: {},
				stages: {},
				status: "corrupt",
				migrationStatus: "uninitialized",
				legacyMissingPaths: [],
			},
			`a schema-3 ${kind} stage without a ref fails closed as one atomic record`,
		);
	}
}

console.log("\n--- IndexedDB blob settled refs: host/vault/device isolation ---");
{
	const dbName = uniqueDbName("scope");
	const scopes: BlobSettledRefScope[] = [
		SCOPE,
		{ ...SCOPE, host: "https://sync.example/" },
		{ ...SCOPE, vaultId: "vault-b" },
		{ ...SCOPE, localDeviceId: "device-b" },
	];
	for (const [index, scope] of scopes.entries()) {
		await new IndexedDbBlobSettledRefStore(scope, indexedDB, dbName).save({
			[`assets/${index}.png`]: { ...REF_B, size: index },
		});
	}
	for (const [index, scope] of scopes.entries()) {
		assert.deepEqual(
			await new IndexedDbBlobSettledRefStore(scope, indexedDB, dbName).load(),
			{ [`assets/${index}.png`]: { ...REF_B, size: index } },
		);
	}

	await new IndexedDbBlobSettledRefStore(SCOPE, indexedDB, dbName).clear();
	assert.deepEqual(
		await new IndexedDbBlobSettledRefStore(SCOPE, indexedDB, dbName).loadWithStatus(),
		{
			cache: {},
			sourceVersions: {},
			stages: {},
			status: "missing",
			migrationStatus: "uninitialized",
			legacyMissingPaths: [],
		},
	);
	assert.deepEqual(
		await new IndexedDbBlobSettledRefStore(scopes[1]!, indexedDB, dbName).load(),
		{ "assets/1.png": { ...REF_B, size: 1 } },
		"clear must not erase a different exact host tuple",
	);
}

console.log("\n--- IndexedDB blob settled refs: migration quarantine is atomic and restart-safe ---");
{
	const dbName = uniqueDbName("migration");
	const store = new IndexedDbBlobSettledRefStore(SCOPE, indexedDB, dbName);
	await store.save(
		{ "assets/present.png": REF_A },
		{
			legacyMissingPaths: [
				"./assets\\deleted.png",
				"assets/renamed-away.png",
			],
		},
	);
	assert.deepEqual(
		jsonValue(await new IndexedDbBlobSettledRefStore(
			SCOPE,
			indexedDB,
			dbName,
		).loadWithStatus()),
		{
			cache: { "assets/present.png": REF_A },
			sourceVersions: {},
			stages: {},
			status: "loaded",
			migrationStatus: "initialized",
			legacyMissingPaths: [
				"assets/deleted.png",
				"assets/renamed-away.png",
			],
		},
		"a restart reloads both settlement authority and the unresolved upgrade fence",
	);

	const legacyDbName = uniqueDbName("legacy-schema");
	await new IndexedDbBlobSettledRefStore(SCOPE, indexedDB, legacyDbName).save({});
	const key = buildBlobSettledRefStoreKey(SCOPE);
	await putRaw(legacyDbName, key, persisted([
		{ path: "assets/legacy.png", ref: REF_B },
	]));
	assert.deepEqual(
		jsonValue(await new IndexedDbBlobSettledRefStore(
			SCOPE,
			indexedDB,
			legacyDbName,
		).loadWithStatus()),
		{
			cache: { "assets/legacy.png": REF_B },
			sourceVersions: {},
			stages: {},
			status: "loaded",
			migrationStatus: "uninitialized",
			legacyMissingPaths: [],
		},
		"schema-1 cache authority remains readable but cannot impersonate an initialized migration marker",
	);

	const previousDbName = uniqueDbName("schema-2-migration");
	await new IndexedDbBlobSettledRefStore(SCOPE, indexedDB, previousDbName).save({});
	await putRaw(previousDbName, key, persistedV2(
		[{ path: "assets/schema-2.png", ref: REF_A }],
		["./assets\\legacy-missing.png"],
	));
	assert.deepEqual(
		jsonValue(await new IndexedDbBlobSettledRefStore(
			SCOPE,
			indexedDB,
			previousDbName,
		).loadWithStatus()),
		{
			cache: { "assets/schema-2.png": REF_A },
			sourceVersions: {},
			stages: {},
			status: "loaded",
			migrationStatus: "initialized",
			legacyMissingPaths: ["assets/legacy-missing.png"],
		},
		"schema-2 retains initialized migration semantics while source versions and stages start empty",
	);
}

console.log("\n--- IndexedDB blob settled refs: invalid saves reject atomically ---");
{
	const dbName = uniqueDbName("invalid-save");
	const store = new IndexedDbBlobSettledRefStore(SCOPE, indexedDB, dbName);
	const baselineStages: BlobSettlementStageCache = {
		"assets/pending.png": {
			stageId: "baseline-stage",
			kind: "download",
			ref: REF_B,
			sourceVersion: SOURCE_VERSION_B,
			stagedAt: 100,
		},
	};
	await store.save(
		{ "assets/good.png": REF_A },
		{
			legacyMissingPaths: [],
			sourceVersions: { "assets/good.png": SOURCE_VERSION_A },
			stages: baselineStages,
		},
	);

	await assert.rejects(
		store.save({
			"assets/a.png": REF_A,
			"assets\\a.png": REF_B,
		}),
		/invalid blob settled ref cache/i,
		"two display paths that normalize to one identity are ambiguous",
	);
	await assert.rejects(
		store.save({
			"assets/bad.png": { hash: "A".repeat(64), size: 1 } as BlobRef,
		}),
		/invalid blob settled ref cache/i,
	);
	await assert.rejects(
		store.save({
			"assets/bad-size.png": { hash: "e".repeat(64), size: 1.5 } as BlobRef,
		}),
		/invalid blob settled ref cache/i,
	);
	await assert.rejects(
		store.save(
			{ "assets/good.png": REF_A },
			{
				legacyMissingPaths: [],
				sourceVersions: { "assets/not-settled.png": SOURCE_VERSION_A },
			},
		),
		/invalid blob settled source versions/i,
		"source version keys cannot exist outside the settled cache",
	);
	await assert.rejects(
		store.save(
			{ "assets/good.png": REF_A },
			{
				legacyMissingPaths: [],
				sourceVersions: { "assets/good.png": "client:clock" },
			},
		),
		/invalid blob settled source versions/i,
		"source versions must retain an exact numeric client:clock identity",
	);
	await assert.rejects(
		store.save(
			{ "assets/good.png": REF_A },
			{
				legacyMissingPaths: [],
				stages: {
					"assets/bad-stage.png": {
						stageId: "",
						kind: "download",
						ref: REF_B,
						stagedAt: -1,
					},
				} as BlobSettlementStageCache,
			},
		),
		/invalid blob settlement stages/i,
		"malformed stage identity and timestamp reject the entire save",
	);
	assert.deepEqual(
		jsonValue(await store.loadWithStatus()),
		{
			cache: { "assets/good.png": REF_A },
			sourceVersions: { "assets/good.png": SOURCE_VERSION_A },
			stages: baselineStages,
			status: "loaded",
			migrationStatus: "initialized",
			legacyMissingPaths: [],
		},
		"a rejected save preserves the last complete cache, source versions, and stages atomically",
	);
}

console.log("\n--- IndexedDB blob settled refs: corrupt payloads fail closed as a whole ---");
{
	const dbName = uniqueDbName("corrupt");
	const store = new IndexedDbBlobSettledRefStore(SCOPE, indexedDB, dbName);
	await store.save({});
	assert.deepEqual(
		await store.loadWithStatus(),
		{
			cache: {},
			sourceVersions: {},
			stages: {},
			status: "loaded",
			migrationStatus: "initialized",
			legacyMissingPaths: [],
		},
		"a valid persisted empty inventory is not corruption",
	);
	const key = buildBlobSettledRefStoreKey(SCOPE);
	const valid = { path: "assets/valid.png", ref: REF_A };

	await putRaw(dbName, key, { schema: 4, scope: SCOPE, entries: [valid] });
	assert.deepEqual(await store.load(), {}, "unsupported schema must fail closed");

	await putRaw(dbName, key, persistedV3([
		{ ...valid, sourceVersion: "client:clock" },
	]));
	assert.deepEqual(await store.load(), {}, "malformed settled source version corrupts schema 3");

	await putRaw(dbName, key, persistedV3(
		[{ ...valid, sourceVersion: SOURCE_VERSION_A }],
		[{
			path: "assets/staged.png",
			stageId: "stage-valid",
			kind: "unknown",
			ref: REF_B,
			sourceVersion: SOURCE_VERSION_B,
			stagedAt: 100,
		}],
	));
	assert.deepEqual(await store.load(), {}, "unknown stage kind corrupts the whole schema-3 record");

	await putRaw(dbName, key, persistedV3(
		[valid],
		[{
			path: "assets/staged.png",
			stageId: " ",
			kind: "download",
			ref: REF_B,
			sourceVersion: "1:-1",
			stagedAt: 1.5,
		}],
	));
	assert.deepEqual(
		await store.loadWithStatus(),
		{
			cache: {},
			sourceVersions: {},
			stages: {},
			status: "corrupt",
			migrationStatus: "uninitialized",
			legacyMissingPaths: [],
		},
		"invalid stage id, source version, or timestamp fails closed as one atomic record",
	);

	await putRaw(dbName, key, persistedV3(
		[valid],
		[
			{
				path: "assets/staged.png",
				stageId: "stage-a",
				kind: "rename",
				ref: REF_A,
				stagedAt: 100,
			},
			{
				path: "./assets\\staged.png",
				stageId: "stage-b",
				kind: "retire",
				ref: REF_A,
				stagedAt: 101,
			},
		],
	));
	assert.deepEqual(await store.load(), {}, "normalized stage path collisions fail closed");

	const validStage = {
		path: "assets/staged-valid.png",
		stageId: "stage-strict",
		kind: "upload",
		ref: REF_B,
		stagedAt: 102,
	};
	const malformedStageCases: Array<[unknown, string]> = [
		[{ ...validStage, path: "assets/staged/" }, "non-file stage path"],
		[{ ...validStage, ref: { ...REF_B, unexpected: true } }, "unknown ref field"],
		[{ ...validStage, unexpected: true }, "unknown stage field"],
	];
	for (const [malformedStage, label] of malformedStageCases) {
		await putRaw(dbName, key, persistedV3([valid], [malformedStage]));
		assert.deepEqual(
			await store.load(),
			{},
			`${label} fails strict schema-3 validation`,
		);
	}

	await putRaw(dbName, key, {
		...(persistedV3([valid]) as Record<string, unknown>),
		unexpected: true,
	});
	assert.deepEqual(await store.load(), {}, "unknown schema-3 payload fields fail closed");

	await putRaw(dbName, key, persisted([valid], { ...SCOPE, localDeviceId: "foreign" }));
	assert.deepEqual(await store.load(), {}, "payload scope mismatch must fail closed");

	await putRaw(dbName, key, persistedV2([valid], ["assets/a.png", "assets\\a.png"]));
	assert.deepEqual(
		await store.load(),
		{},
		"ambiguous migration quarantine paths corrupt the whole scoped record",
	);

	await putRaw(dbName, key, persisted([
		valid,
		{ path: "assets/corrupt.png", ref: { hash: "not-a-hash", size: 1 } },
	]));
	assert.deepEqual(
		await store.loadWithStatus(),
		{
			cache: {},
			sourceVersions: {},
			stages: {},
			status: "corrupt",
			migrationStatus: "uninitialized",
			legacyMissingPaths: [],
		},
		"one corrupt ref must reject the whole authority payload",
	);

	await putRaw(dbName, key, persisted([
		valid,
		{ path: "assets\\valid.png", ref: REF_B },
	]));
	assert.deepEqual(await store.load(), {}, "normalized path collisions must reject the whole payload");

	await putRaw(dbName, key, persisted([{
		path: "assets/lineage.png",
		ref: {
			hash: "a".repeat(64),
			size: 1,
			priorHashes: ["b".repeat(64), "b".repeat(64)],
		},
	}]));
	assert.deepEqual(await store.load(), {}, "duplicate causal predecessors are corrupt");
}

console.log("\n--- IndexedDB blob settled refs: operational failures reject ---");
{
	const failedFactory = {
		open(): IDBOpenDBRequest {
			throw new Error("IndexedDB unavailable");
		},
	};
	const makeStore = () => new IndexedDbBlobSettledRefStore(
		SCOPE,
		failedFactory as Pick<IDBFactory, "open">,
		"unavailable",
	);
	await assert.rejects(makeStore().load(), /IndexedDB unavailable/);
	await assert.rejects(makeStore().loadWithStatus(), /IndexedDB unavailable/);
	await assert.rejects(makeStore().save({}), /IndexedDB unavailable/);
	await assert.rejects(makeStore().clear(), /IndexedDB unavailable/);
}

console.log("\nIndexedDB blob settled ref store: all tests passed\n");
