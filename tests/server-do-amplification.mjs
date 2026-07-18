// Regression test for issue #40: DO subrequest amplification fix.
//
// Static source-analysis checks that enforce the cost invariants listed in
// the issue #40 / ca0dad2 post-mortem. A companion runtime test is in
// tests/server-route-classification-runtime.ts.
//
// These tests fail loudly if a future change re-introduces any of the
// amplification patterns:
//
//   1. syncSocket.ts must not call recordVaultTrace at all (ws admission events
//      are console-only; a reconnect storm must not burn KAOS_SYNC writes).
//   2. index.ts must classify routes before calling getAuthStateCached.
//   3. auth.ts must have a TTL cache around getStoredServerConfig.
//   4. Cheap room operations must bypass getServerByName's /set-name/ request.
//   5. server.ts must NOT call ensureDocumentLoaded in /__kaos/debug.
//   6. The client must not poll server trace while idle.
//   7. Every remaining getServerByName call under server/src must be explicitly
//      approved.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const syncSocketPath = resolve(here, "../server/src/routes/syncSocket.ts");
const indexPath = resolve(here, "../server/src/index.ts");
const authPath = resolve(here, "../server/src/routes/auth.ts");
const mainPath = resolve(here, "../src/main.ts");
const serverPath = resolve(here, "../server/src/server.ts");
const serverSrcDir = resolve(here, "../server/src");
const traceRoutesPath = resolve(here, "../server/src/routes/trace.ts");
const traceRuntimePath = resolve(here, "../src/runtime/traceRuntimeController.ts");

let passed = 0;
let failed = 0;

function assert(condition, name) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

// ── Test 1: syncSocket.ts has no recordVaultTrace calls ───────────────────────
console.log("\n--- Test 1: syncSocket.ts has no recordVaultTrace calls (WebSocket admission is console-only) ---");
{
	const source = readFileSync(syncSocketPath, "utf8");

	assert(
		!/recordVaultTrace\s*\(/.test(source),
		"syncSocket.ts contains no recordVaultTrace() calls",
	);
	assert(
		!source.includes('"ws-connected"'),
		"syncSocket.ts does not trace 'ws-connected' string (not persisted to KAOS_SYNC)",
	);
	assert(
		!/import.*recordVaultTrace/.test(source),
		"syncSocket.ts does not import recordVaultTrace",
	);
	// ws-rejected events should also be console-only (schema-skew loops)
	assert(
		!source.includes('"ws-rejected"') || !/recordVaultTrace/.test(source),
		"ws-rejected event is not passed to recordVaultTrace",
	);
}

// ── Test 2: index.ts classifies routes before auth ────────────────────────────
console.log("\n--- Test 2: index.ts classifies routes before auth (unknown paths 404 without DO access) ---");
{
	const source = readFileSync(indexPath, "utf8");

	assert(
		/function\s+classifyWorkerRoute\s*\(/.test(source),
		"classifyWorkerRoute function is defined in index.ts",
	);
	assert(
		/WorkerRoute/.test(source),
		"WorkerRoute type is defined in index.ts",
	);
	assert(
		!source.includes("await getAuthState(env)"),
		"index.ts no longer calls uncached getAuthState(env) in the fetch handler",
	);
	assert(
		source.includes("getAuthStateCached("),
		"index.ts calls getAuthStateCached instead of getAuthState",
	);
	// Vault resource whitelist must be present
	assert(
		/VALID_VAULT_RESOURCES/.test(source),
		"index.ts defines VALID_VAULT_RESOURCES whitelist",
	);
	assert(
		/VALID_VAULT_RESOURCES\.has\(/.test(source),
		"classifyWorkerRoute uses VALID_VAULT_RESOURCES.has() to reject unknown resources",
	);
	// The four known resources must be in the whitelist
	const whitelistMatch = source.match(/VALID_VAULT_RESOURCES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
	const whitelistText = whitelistMatch ? whitelistMatch[1] : "";
	assert(whitelistText.includes('"auth"'), "VALID_VAULT_RESOURCES includes auth");
	assert(whitelistText.includes('"debug"'), "VALID_VAULT_RESOURCES includes debug");
	assert(whitelistText.includes('"blobs"'), "VALID_VAULT_RESOURCES includes blobs");
	assert(whitelistText.includes('"snapshots"'), "VALID_VAULT_RESOURCES includes snapshots");

	// Full route-shape validator must exist
	assert(
		/function\s+isKnownVaultRouteShape\s*\(/.test(source),
		"isKnownVaultRouteShape function is defined in index.ts",
	);
	assert(
		/isKnownVaultRouteShape\s*\(/.test(source.slice(source.indexOf("function classifyWorkerRoute"))),
		"classifyWorkerRoute calls isKnownVaultRouteShape",
	);

	// parseSyncPath MUST be called before parseVaultPath in the classifier.
	// If the order were reversed, /vault/sync/:id would be misread as a vault
	// route and rejected by the resource whitelist as not-found.
	const classifyBody = source.slice(source.indexOf("function classifyWorkerRoute"));
	const syncPos = classifyBody.indexOf("parseSyncPath(");
	const vaultPos = classifyBody.indexOf("parseVaultPath(");
	assert(
		syncPos !== -1 && vaultPos !== -1 && syncPos < vaultPos,
		"parseSyncPath() is called before parseVaultPath() in classifyWorkerRoute (sync ordering invariant)",
	);

	// Verify not-found short-circuit appears BEFORE the getAuthStateCached call
	// in the worker fetch handler body.
	const fetchStart = source.indexOf("async fetch(req:");
	assert(fetchStart !== -1, "fetch handler is found in index.ts");
	if (fetchStart !== -1) {
		const afterFetch = source.slice(fetchStart);
		const notFoundPos = afterFetch.indexOf('route.kind === "not-found"');
		const authCachedPos = afterFetch.indexOf("getAuthStateCached(");
		assert(
			notFoundPos !== -1 && authCachedPos !== -1 && notFoundPos < authCachedPos,
			"not-found check (no DO access) appears before getAuthStateCached call in fetch handler",
		);
	}
}

// ── Test 3: auth.ts has TTL cache ─────────────────────────────────────────────
console.log("\n--- Test 3: auth.ts has TTL cache for KAOS_CONFIG fetches ---");
{
	const source = readFileSync(authPath, "utf8");

	assert(
		/AUTH_CONFIG_CACHE_TTL_MS/.test(source),
		"auth.ts defines AUTH_CONFIG_CACHE_TTL_MS",
	);
	assert(
		/cachedConfig/.test(source),
		"auth.ts has a cachedConfig module-level variable",
	);
	assert(
		/getStoredServerConfigCached/.test(source),
		"auth.ts exports getStoredServerConfigCached",
	);
	assert(
		/invalidateStoredServerConfigCache/.test(source),
		"auth.ts exports invalidateStoredServerConfigCache",
	);
	assert(
		/getAuthStateCached/.test(source),
		"auth.ts exports getAuthStateCached",
	);
	// Ensure handleClaimRoute calls invalidateStoredServerConfigCache
	assert(
		/handleClaimRoute[\s\S]*?invalidateStoredServerConfigCache/.test(source),
		"handleClaimRoute calls invalidateStoredServerConfigCache after successful claim",
	);
	// Ensure handleUpdateMetadataRoute calls invalidateStoredServerConfigCache
	assert(
		/handleUpdateMetadataRoute[\s\S]*?invalidateStoredServerConfigCache/.test(source),
		"handleUpdateMetadataRoute calls invalidateStoredServerConfigCache after successful update",
	);
}

// ── Test 4: cheap room operations bypass PartyServer /set-name amplification ─
console.log("\n--- Test 4: cheap room operations bypass getServerByName /set-name amplification ---");
{
	const source = readFileSync(traceRoutesPath, "utf8");

	assert(
		source.includes("fetchVaultRoomCheap"),
		"trace routes define a direct cheap-room fetch helper",
	);
	assert(
		/fetchVaultRoomCheap[\s\S]*?KAOS_SYNC\.idFromName[\s\S]*?KAOS_SYNC\.get/.test(source),
		"cheap-room helper resolves the Durable Object directly",
	);
	assert(
		/fetchVaultRoomCheap[\s\S]*?x-partykit-room/.test(source),
		"cheap-room helper carries the room id without a separate set-name request",
	);

	for (const functionName of ["fetchVaultRoomMeta", "fetchVaultDebug"]) {
		const start = source.indexOf(`function ${functionName}`);
		const nextExport = start === -1 ? -1 : source.indexOf("\nexport ", start + 1);
		const body = start === -1 ? "" : source.slice(start, nextExport === -1 ? source.length : nextExport);
		assert(
			body.includes("fetchVaultRoomCheap") && !body.includes("getServerByName"),
			`${functionName} uses one direct DO request and no getServerByName call`,
		);
	}

	const traceStart = source.indexOf("export async function recordVaultTrace");
	const traceEnd = traceStart === -1 ? -1 : source.indexOf("\nexport ", traceStart + 1);
	const traceBody = traceStart === -1 ? "" : source.slice(traceStart, traceEnd === -1 ? source.length : traceEnd);
	assert(
		traceBody.includes("fetchVaultRoomCheap") && !traceBody.includes("getServerByName"),
		"recordVaultTrace uses one direct DO request and no getServerByName call",
	);
}

// ── Test 5: /__kaos/debug does not call ensureDocumentLoaded ──────────────────
console.log("\n--- Test 5: /__kaos/debug does not call ensureDocumentLoaded (cheap debug path) ---");
{
	const source = readFileSync(serverPath, "utf8");

	// Find the /__kaos/debug handler and check its body
	const debugMarker = source.indexOf('"/__kaos/debug"');
	assert(debugMarker !== -1, "/__kaos/debug handler is present in server.ts");

	if (debugMarker !== -1) {
		// Extract the if-block body by brace matching
		let braceStart = source.indexOf("{", debugMarker);
		let debugBody = null;
		if (braceStart !== -1) {
			let depth = 0;
			for (let i = braceStart; i < source.length; i++) {
				if (source[i] === "{") depth++;
				else if (source[i] === "}") {
					depth--;
					if (depth === 0) {
						debugBody = source.slice(braceStart + 1, i);
						break;
					}
				}
			}
		}
		assert(debugBody !== null, "/__kaos/debug handler body is parseable");
		assert(
			// Check for actual call pattern, not just the identifier (which
			// appears in comments explaining the absence of the call).
			debugBody !== null && !/await\s+this\.ensureDocumentLoaded\s*\(\s*\)/.test(debugBody),
			"/__kaos/debug does not call ensureDocumentLoaded (no cold-start checkpoint load on debug poll)",
		);
		// The cheap path should still return trace entries
		assert(
			debugBody !== null && debugBody.includes("listRecentTraceEntries"),
			"/__kaos/debug still reads trace entries from storage",
		);
	}
}

// ── Test 6: trace runtime does not poll the server while idle ─────────────────
console.log("\n--- Test 6: trace runtime does not poll server trace while idle ---");
{
	const source = readFileSync(traceRuntimePath, "utf8");
	assert(
		!source.includes("serverInterval"),
		"trace runtime has no periodic server interval",
	);
	assert(
		!/setInterval\s*\(\s*\(\)\s*=>\s*\{[\s\S]{0,200}fetchServerTrace/.test(source),
		"trace runtime never schedules fetchServerTrace with setInterval",
	);
	assert(
		/async refreshServerTrace\(\)[\s\S]{0,100}fetchServerTrace/.test(source),
		"explicit server trace refresh remains available",
	);
}

// ── Test 7: route-bucket logging is present and not_found is sampled ──────────
console.log("\n--- Test 7: index.ts has route-bucket logging with not_found sampling ---");
{
	const source = readFileSync(indexPath, "utf8");

	assert(
		/function\s+routeBucket\s*\(/.test(source),
		"routeBucket function is defined in index.ts",
	);
	assert(
		/function\s+logWorkerRequest\s*\(/.test(source),
		"logWorkerRequest function is defined in index.ts",
	);
	assert(
		/console\.info/.test(source),
		"logWorkerRequest uses console.info for structured output",
	);
	// not_found must be sampled (not logged unconditionally)
	assert(
		/not-found.*Math\.random|Math\.random.*not-found/.test(source.replace(/\s+/g, " ")),
		"logWorkerRequest samples not_found routes (not unconditional logging)",
	);
	// Raw vault IDs must not appear in the log payload
	assert(
		!/logWorkerRequest\s*\(\s*\{[^}]*vaultId/.test(source),
		"logWorkerRequest call sites do not include raw vaultId in the log payload",
	);
}

// ── Test 8: AuthStateCached type exists with required config ──────────────────
console.log("\n--- Test 8: AuthStateCached type has required config for claim/unclaimed modes ---");
{
	const typesPath = resolve(here, "../server/src/routes/types.ts");
	const source = readFileSync(typesPath, "utf8");

	assert(
		/AuthStateCached/.test(source),
		"types.ts defines AuthStateCached",
	);
	// In AuthStateCached, config must be required (not optional) for claim/unclaimed
	// The type definition should have `config: StoredServerConfig` (no ?)
	const cachedTypePos = source.indexOf("export type AuthStateCached");
	assert(cachedTypePos !== -1, "AuthStateCached is found in types.ts");
	if (cachedTypePos !== -1) {
		// Grab the type definition block (large enough to cover all three variants)
		const typeBlock = source.slice(cachedTypePos, cachedTypePos + 400);
		// Should NOT have "config?" (optional) in the cached type
		assert(
			!/config\?:/.test(typeBlock),
			"AuthStateCached claim/unclaimed variants have required config (no config?)",
		);
		// Should have "config: StoredServerConfig" (required)
		assert(
			/config:\s*StoredServerConfig/.test(typeBlock),
			"AuthStateCached has required config: StoredServerConfig",
		);
	}
}

// ── Test 9: every document-owning getServerByName call is allowlisted ────────
console.log("\n--- Test 9: getServerByName server calls are explicitly allowlisted ---");
{
	// These operations intentionally enter PartyServer's document lifecycle.
	// Any new call must be cost-reviewed and added here with an explanation in
	// docs/engineering/durable-object-cost-guardrails.md.
	const approvedCalls = new Map([
		["routes/recoverySnapshots.ts", 1], // document-based recovery snapshot mutation
		["routes/snapshots.ts", 1], // document-based daily snapshot mutation
		["routes/syncSocket.ts", 1], // accepted WebSocket sync connection
		["routes/trace.ts", 1], // explicit full-document export for schema fallback/snapshot
	]);

	function listTypeScriptFiles(directory) {
		return readdirSync(directory, { withFileTypes: true })
			.sort((left, right) => left.name.localeCompare(right.name))
			.flatMap((entry) => {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) return listTypeScriptFiles(path);
				return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
			});
	}

	function countGetServerByNameCalls(file, source) {
		const sourceFile = ts.createSourceFile(
			file,
			source,
			ts.ScriptTarget.Latest,
			false,
			ts.ScriptKind.TS,
		);
		const directBindings = new Set();
		const namespaceBindings = new Set();
		for (const statement of sourceFile.statements) {
			if (
				!ts.isImportDeclaration(statement) ||
				!ts.isStringLiteral(statement.moduleSpecifier) ||
				statement.moduleSpecifier.text !== "partyserver"
			) {
				continue;
			}
			const importClause = statement.importClause;
			if (!importClause || importClause.isTypeOnly || !importClause.namedBindings) continue;
			if (ts.isNamespaceImport(importClause.namedBindings)) {
				namespaceBindings.add(importClause.namedBindings.name.text);
				continue;
			}
			for (const specifier of importClause.namedBindings.elements) {
				const importedName = (specifier.propertyName ?? specifier.name).text;
				if (!specifier.isTypeOnly && importedName === "getServerByName") {
					directBindings.add(specifier.name.text);
				}
			}
		}

		let count = 0;
		function visit(node) {
			if (ts.isCallExpression(node)) {
				const expression = node.expression;
				const isDirectCall =
					ts.isIdentifier(expression) && directBindings.has(expression.text);
				const isNamespaceCall =
					ts.isPropertyAccessExpression(expression) &&
					ts.isIdentifier(expression.expression) &&
					namespaceBindings.has(expression.expression.text) &&
					expression.name.text === "getServerByName";
				if (isDirectCall || isNamespaceCall) count++;
			}
			ts.forEachChild(node, visit);
		}
		visit(sourceFile);
		return count;
	}

	assert(
		countGetServerByNameCalls(
			"aliased-partyserver-import.ts",
			'import { getServerByName as wakeRoom } from "partyserver";\nwakeRoom(namespace, room);',
		) === 1,
		"aliased partyserver getServerByName imports are counted",
	);
	assert(
		countGetServerByNameCalls(
			"namespace-partyserver-import.ts",
			'import * as partyserver from "partyserver";\npartyserver.getServerByName(namespace, room);',
		) === 1,
		"namespace partyserver getServerByName calls are counted",
	);
	assert(
		countGetServerByNameCalls(
			"non-call-partyserver-references.ts",
			'import { getServerByName } from "partyserver";\n// getServerByName(namespace, room)\nconst label = "getServerByName(namespace, room)";',
		) === 0,
		"partyserver imports, comments, and strings are not counted as calls",
	);

	const observedCalls = new Map();
	for (const file of listTypeScriptFiles(serverSrcDir)) {
		const source = readFileSync(file, "utf8");
		const count = countGetServerByNameCalls(file, source);
		if (count > 0) observedCalls.set(relative(serverSrcDir, file), count);
	}

	assert(
		[...observedCalls.keys()].every((file) => approvedCalls.has(file)),
		"no server source file introduces an unapproved getServerByName call site",
	);
	assert(
		[...approvedCalls.entries()].every(([file, count]) => observedCalls.get(file) === count),
		"approved getServerByName call counts match the reviewed document-owning paths",
	);
}

// ── Test 10: missing optional R2 does not trigger capability polling ─────────
console.log("\n--- Test 10: capability polling is bounded to an active guided update ---");
{
	const source = readFileSync(mainPath, "utf8");
	assert(
		!source.includes("waitingForR2"),
		"missing optional R2 capability does not create an indefinite polling condition",
	);
	assert(
		source.includes("waitingForGuidedUpdate") && source.includes('refreshServerCapabilities("guided-update-poll")'),
		"capability polling is named and gated as guided-update monitoring",
	);
	assert(
		!source.includes('refreshServerCapabilities("background-poll")'),
		"generic background capability polling is absent",
	);
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
