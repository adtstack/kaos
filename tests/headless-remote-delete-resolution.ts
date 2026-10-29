import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as Y from "yjs";
import { TFile, normalizePath } from "obsidian";
import { VaultSync } from "../src/sync/vaultSync";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import {
	PreservedUnresolvedRegistry, getPreservedUnresolvedEpisodeId,
	isRemoteDeletePreservedUnresolvedEntry,
} from "../src/sync/preservedUnresolved";
import { withAttentionResolutionLock } from "../src/dashboard/attentionResolutionLock";
import { DaemonIpcServer } from "../src/headless-host/kaos/daemonIpcServer";

Object.defineProperty(globalThis, "__KAOS_QA_HARNESS_ENABLED__", { configurable: true, value: false });

// Execute the production plugin methods without booting Obsidian or a socket.
// The controller, Y.Doc, removal fingerprints and Attention registry below are real.
const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const mainAst = ts.createSourceFile("main.ts", mainSource, ts.ScriptTarget.Latest, true);
const pluginClass = mainAst.statements.find(ts.isClassDeclaration)!;
const methodNames = new Set([
	"resolvePreservedUnresolvedEntry", "resolveRemoteDeleteAttention",
	"getCurrentRemoteDeleteAttention", "assertRemoteDeleteFingerprint",
	"getDashboardLocalFileIdentity", "assertDashboardLocalFileIdentity", "clearPreservedUnresolvedAttention",
]);
const methods = pluginClass.members.filter(member => ts.isMethodDeclaration(member)
	&& methodNames.has(member.name.getText(mainAst)));
assert.equal(methods.length, methodNames.size, "every production resolution method must be loaded");
const globals = { TFile, normalizePath, getPreservedUnresolvedEpisodeId,
	isRemoteDeletePreservedUnresolvedEntry, withAttentionResolutionLock };
const compiled = ts.transpileModule(
	`class PluginMethods { ${methods.map(method => method.getText(mainAst)).join("\n")} }\nreturn PluginMethods;`,
	{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;
const PluginMethods = new Function(...Object.keys(globals), compiled)(...Object.values(globals));

function makeSync(): VaultSync {
	const sync = Object.create(VaultSync.prototype) as any;
	sync.ydoc = new Y.Doc();
	for (const name of ["pathToId", "idToText", "meta", "sys", "pathToBlob", "blobMeta", "blobTombstones"]) {
		sync[name] = sync.ydoc.getMap(name);
	}
	Object.assign(sync, {
		_textToFileId: new WeakMap(), _pathIndex: new Map(), _deletedPathIndex: new Set(),
		_activePathCollisions: new Map(), _pathIndexesDirty: true,
		_renameBatch: new Map(), _renameBatchNewToOld: new Map(), _eventRing: [],
		provider: { wsconnected: true },
		serverAckTracker: { withActiveOpId: (_id: string, work: () => unknown) => work() },
	});
	sync.sys.set("schemaVersion", 4);
	return sync;
}

function makeFixture(options: {
	kind?: "markdown" | "blob";
	reason?: string;
	trash?: "success" | "fail" | "noop";
	onStableRead?: (sync: VaultSync) => void;
	queueSaveFails?: boolean;
} = {}) {
	const kind = options.kind ?? "markdown";
	const path = kind === "markdown" ? "notes/removed.md" : "assets/removed.png";
	const content = "unsent local work\n";
	let file: TFile | null = Object.assign(new TFile(), { path, stat: { mtime: 10, size: content.length } });
	const sync = makeSync();
	if (kind === "markdown") {
		sync.ensureFile(path, "old synced text");
		sync.handleDelete(path);
	} else {
		(sync as any).getAuthoritativeBlobDeleteSnapshot = () => ({fingerprint: "blob-delete-1"});
	}
	const registry = new PreservedUnresolvedRegistry();
	registry.record({ path, kind, reason: (options.reason ?? "remote-delete-local-conflict") as any, at: 1, episodeId: "episode-1" });
	const diskMirror = {
		getPreservedUnresolvedEntries: () => registry.getEntries(),
		clearPreservedUnresolved: () => registry.resolveEpisode(path, "episode-1"),
	};
	let pending = false, queueWrites = 0, trashCalls = 0;
	const blobSync = {
		isKeepLocalRemoteDeletePending: () => pending,
		keepLocalRemoteDeletedBlob: () => { pending = true; },
		isPreservedUnresolved: () => registry.has(path),
		exportQueue: () => ({uploads: [{path}], downloads: []}),
	};
	let diskIndex = {};
	const plugin: any = new PluginMethods();
	const app = {
		vault: {
			getAbstractFileByPath: () => file,
			read: async () => content,
			adapter: {stat: async () => file?.stat ?? null},
		},
		workspace: {iterateAllLeaves: () => {}},
		fileManager: {trashFile: async (expectedFile: TFile) => {
			trashCalls++;
			assert.equal(plugin.attentionMarkdownDeleteInFlight.get(path), expectedFile, "trash echo is fenced before touching disk");
			if (options.trash === "fail") throw new Error("trash blocked");
			if (options.trash !== "noop") file = null;
		}},
	};
	const controller = new ReconciliationController({
		app: app as any, getSettings: () => ({deviceName: "headless-test"}) as any,
		getRuntimeConfig: () => ({maxFileSizeBytes: 0}) as any,
		getVaultSync: () => sync, getDiskMirror: () => diskMirror as any,
		getBlobSync: () => null, getEditorBindings: () => null,
		getDiskIndex: () => diskIndex, setDiskIndex: index => { diskIndex = index; },
		isMarkdownPathSyncable: () => true, shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {}, validateOpenEditorBindings: () => {}, onReconciled: () => {},
		readStableMarkdownFile: async () => {
			options.onStableRead?.(sync);
			return {kind: "ready", file: file!, content, stat: file!.stat};
		},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {}, saveDiskIndex: async () => {},
		refreshStatusBar: () => {}, trace: () => {}, scheduleTraceStateSnapshot: () => {}, log: () => {},
	});
	const history: any[] = [];
	Object.assign(plugin, {
		app, vaultSync: sync, diskMirror, reconciliationController: controller,
		attentionResolutionInFlight: new Set(), attentionMarkdownDeleteInFlight: new Map(),
		preservedUnresolvedEntries: [], collectPreservedUnresolvedEntries: () => registry.getEntries(),
		getBlobSync: () => kind === "blob" ? blobSync : null,
		captureCommittedBlobIntentResolution: () => null, supersedeCommittedBlobIntentsForResolution: async () => {},
		attachmentOrchestrator: {getQueuePersistenceScope: () => ({scope: "test"})},
		persistBlobQueueSnapshot: async () => {
			queueWrites++;
			if (options.queueSaveFails) throw new Error("queue persistence failed");
		},
		persistPluginState: async () => {}, recordResolvedAttention: (item: any) => history.push(item),
		refreshStatusBar: () => {},
	});
	let publishes = 0;
	const server: any = new DaemonIpcServer({socketPath: "/tmp/unused-kaos-resolution-test.sock", plugin,
		publisher: {publishOnce: async () => { publishes++; }} as any});
	return {path, content, sync, registry, plugin, history,
		get file() {return file;}, get trashCalls() {return trashCalls;}, get queueWrites() {return queueWrites;},
		get publishes() {return publishes;},
		resolve: (command: string, action: string) => server.handleRequest({id: "request-1", command,
			params: command === "conflicts.resolve" ? {path, action} : {path, choice: action}}),
	};
}

console.log("\n--- Headless removal resolution uses the dashboard engine path ---");
for (const command of ["conflicts.resolve", "attention.resolve"]) {
	for (const reason of ["remote-delete-local-conflict", "remote-delete-missing-baseline"]) {
		const fixture = makeFixture({reason});
		const response = await fixture.resolve(command, "keep-local");
		assert.equal(response.ok, true);
		assert.equal(response.result.status, "completed");
		assert.equal(fixture.sync.getTextForPath(fixture.path)?.toString(), fixture.content, "Keep local actually publishes the local note");
		assert.equal(fixture.registry.has(fixture.path), false, "the completed Attention episode is cleared");
		assert.equal(fixture.history.length, 1);
		assert.equal(fixture.publishes, 1);
		fixture.sync.ydoc.destroy();
	}
	for (const trash of ["success", "fail", "noop"] as const) {
		const fixture = makeFixture({trash});
		const response = await fixture.resolve(command, "accept-delete");
		assert.equal(response.id, "request-1");
		assert.equal(response.ok, trash === "success");
		assert.equal(fixture.file === null, trash === "success");
		assert.equal(fixture.registry.has(fixture.path), trash !== "success", "failed or ineffective trash keeps Attention");
		assert.equal(fixture.history.length, trash === "success" ? 1 : 0);
		assert.equal(fixture.trashCalls, 1, "the command attempts trash only once");
		assert.equal(fixture.publishes, 1, "the refreshed status is published even after failure");
		if (trash !== "success") assert.match(response.error, /trash blocked|not deleted/);
		assert.equal(fixture.sync.getTextForPath(fixture.path), null, "Accept never revives the deleted note");
		fixture.sync.ydoc.destroy();
	}
	{
		const fixture = makeFixture({onStableRead: sync => {
			sync.ensureFile("notes/removed.md", "new remote work", "remote", {reviveTombstone: true});
		}});
		const response = await fixture.resolve(command, "accept-delete");
		assert.equal(response.ok, false, "a removal changed during disk I/O cannot authorize trash");
		assert.equal(fixture.trashCalls, 0);
		assert.equal(fixture.sync.getTextForPath(fixture.path)?.toString(), "new remote work");
		assert.equal(fixture.registry.has(fixture.path), true);
		fixture.sync.ydoc.destroy();
	}
	{
		const fixture = makeFixture({reason: "path-collision"});
		const response = await fixture.resolve(command, "keep-local");
		assert.equal(response.ok, false, "unsupported reasons cannot silently dismiss a fence");
		assert.equal(fixture.registry.has(fixture.path), true);
		assert.equal(fixture.history.length, 0);
		fixture.sync.ydoc.destroy();
	}
	{
		const fixture = makeFixture({kind: "blob"});
		const response = await fixture.resolve(command, "keep-local");
		assert.equal(response.ok, true);
		assert.equal(response.result.status, "pending", "queued attachment publication is not completion");
		assert.equal(response.result.resolved, undefined);
		assert.equal(fixture.registry.has(fixture.path), true);
		assert.equal(fixture.history.length, 0);
		assert.equal(fixture.queueWrites, 1);
		fixture.sync.ydoc.destroy();
	}
	{
		const fixture = makeFixture({kind: "blob", queueSaveFails: true});
		const response = await fixture.resolve(command, "keep-local");
		assert.equal(response.ok, false, "queue persistence failure is returned to the CLI");
		assert.match(response.error, /queue persistence failed/);
		assert.equal(fixture.registry.has(fixture.path), true);
		assert.equal(fixture.history.length, 0);
		fixture.sync.ydoc.destroy();
	}
}

{
	const server: any = new DaemonIpcServer({socketPath: "/tmp/unused-kaos-resolution-test.sock",
		plugin: {resolvePreservedUnresolvedEntry: async () => undefined} as any,
		publisher: {publishOnce: async () => {}} as any});
	const response = await server.handleRequest({command: "attention.resolve", params: {path: "note.md", choice: "keep-local"}});
	assert.equal(response.ok, false, "a legacy void response cannot masquerade as confirmed completion");
}

const cliSource = readFileSync(new URL("../scripts/kaosctl.mjs", import.meta.url), "utf8");
const cliAst = ts.createSourceFile("kaosctl.mjs", cliSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const formatter = cliAst.statements.find(statement => ts.isFunctionDeclaration(statement)
	&& statement.name?.text === "formatFixResolutionResult")!;
const format = new Function(`${formatter.getText(cliAst)}\nreturn formatFixResolutionResult;`)();
assert.equal(format({status: "pending", message: "Upload pending; Attention remains."}), "Upload pending; Attention remains.");
assert.equal(format({status: "completed"}), "Resolved.");
assert.match(format({conflictPath: "local-copy.md"}), /local-copy.md/);

// Exercise the actual CLI commands with an in-process transport, including
// the interactive pending queue. No socket permissions are needed.
function cliFunction(name: string, bindings: Record<string, unknown>): (...args: any[]) => any {
	const node = cliAst.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)!;
	assert.ok(node, `CLI function ${name} exists`);
	return new Function(...Object.keys(bindings), `${node.getText(cliAst)}\nreturn ${name};`)(...Object.values(bindings));
}
for (const [interactive, remotePresent] of [[false, false], [false, true], [true, false], [true, true]]) {
	const output: string[] = [];
	let attempts = 0;
	const answers = ["1", "k", "y", "q"];
	const runFix = cliFunction("runFixCommand", {
		readJsonFile: async () => ({}), resolve: (path: string) => path,
		defaultUserPaths: () => ({installConfig: "install.json"}), pathsFromConfig: () => ({}),
		findDaemonSocket: () => "unused.sock", existsSync: () => true,
		sendDaemonIpc: async (_socket: string, request: any) => {
			if (request.command === "conflicts.list") return {ok: true, result: {items: [{path: "note.md", type: "preserved-unresolved"}]}};
			if (request.command === "attention.diff") return {ok: true, result: {local: "local", remote: remotePresent ? "remote" : null}};
			attempts++;
			return {ok: true, result: {status: "pending", message: "Upload pending; Attention remains."}};
		},
		FIX_CHOICES: ["keep-local"], formatFixChoiceLabel: (choice: string) => choice,
		formatFixResolutionResult: format, renderSimpleLineDiff: () => "diff",
		console: {log: (message: string) => output.push(message)},
		process: {stdin: {isTTY: true}, stdout: {isTTY: true}},
		readline: {createInterface: () => ({question: async () => {
			assert.ok(answers.length > 0, "pending handling does not create an automatic prompt loop");
			return answers.shift();
		}, close: () => {}})},
	});
	await runFix(interactive ? {} : {path: "note.md", choice: "keep-local"});
	assert.equal(attempts, 1, "a pending upload is never retried automatically");
	assert.ok(output.includes("Upload pending; Attention remains."));
	assert.ok(!output.some(line => line === "Resolved." || line.includes("All attention items resolved")));
	if (interactive) assert.ok(output.some(line => line.includes("1 item(s) still need attention")));
	if (interactive && !remotePresent) assert.ok(output.some(line => line.includes("synced file was removed")), "a removed note remains actionable even without remote text to diff");
}

for (const succeeded of [true, false]) {
	const apply = cliFunction("applyConflictAction", {
		requireConflictItemWithContext: async () => ({context: {dataFiles: ["/state/data.json"], vaultRoot: "/vault"},
			item: {type: "preserved-unresolved", path: "note.md"}}),
		readResolverLock: async () => ({held: true}), dirname: () => "/state", join: (...parts: string[]) => parts.join("/"),
		existsSync: () => true,
		sendDaemonIpc: async (_socket: string, request: any) => request.command === "ping" ? {ok: true}
			: succeeded ? {ok: true, result: {status: "pending", message: "Still uploading"}}
				: {ok: false, error: "trash blocked"},
		assertNoHeadlessLock: () => {throw new Error("unsafe offline fallback");},
	});
	if (succeeded) {
		const result = await apply({}, "entry", "keep-local");
		assert.equal(result.status, "pending", "the legacy conflicts command preserves pending status");
		assert.equal(result.message, "Still uploading");
	} else {
		await assert.rejects(apply({}, "entry", "accept-delete"), /trash blocked/, "daemon failures remain visible without falling back to disk-only resolution");
	}
}
console.log("PASS headless removal resolution: publication, trash errors, stale authority, and pending outcomes");
