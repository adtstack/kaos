#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { analyzeEnsureFileSource } from "./ensure-file-writer-detector.mjs";

function analyze(source) {
	return analyzeEnsureFileSource("synthetic/fixture.ts", source);
}

function violationCategories(source) {
	return analyze(source).violations.map((violation) => violation.category);
}

function assertViolationCounts(source, expected) {
	const actual = Object.fromEntries(
		Object.entries(
			violationCategories(source).reduce((counts, category) => {
				counts[category] = (counts[category] ?? 0) + 1;
				return counts;
			}, {}),
		).sort(([left], [right]) => left.localeCompare(right)),
	);
	assert.deepEqual(actual, expected);
}

function onlyObservedEntry(result) {
	assert.equal(result.observedCounts.size, 1, "expected one inventoried owner");
	return [...result.observedCounts.entries()][0];
}

export function runEnsureFileWriterDetectorAdversarialTests() {
	let passed = 0;
	let failed = 0;

	function check(label, run) {
		try {
			run();
			console.log(`  PASS  ${label}`);
			passed++;
		} catch (error) {
			console.error(`  FAIL  ${label}`);
			console.error(`        ${error instanceof Error ? error.message : String(error)}`);
			failed++;
		}
	}

	console.log("\n--- ensureFile writer detector: declaration and parameter binding aliases ---");
	check("variable BindingElement with identifier property is rejected exactly once", () => {
		assertViolationCounts("const { ensureFile: f } = vaultSync;", { "binding-alias": 1 });
	});
	check("parameter BindingElement with identifier property is rejected exactly once", () => {
		assertViolationCounts("function take({ ensureFile: f }) { f(); }", { "binding-alias": 1 });
	});
	check("computed string-literal BindingElement property is rejected exactly once", () => {
		assertViolationCounts("const { [\"ensureFile\"]: f } = vaultSync;", { "binding-alias": 1 });
	});

	console.log("\n--- ensureFile writer detector: assignment destructuring aliases ---");
	check("assignment ObjectLiteral property alias is rejected exactly once", () => {
		assertViolationCounts("let f; ({ ensureFile: f } = vaultSync);", { "binding-alias": 1 });
	});
	check("assignment ObjectLiteral shorthand alias is rejected exactly once", () => {
		assertViolationCounts("let ensureFile; ({ ensureFile } = vaultSync);", { "binding-alias": 1 });
	});
	check("for-of ObjectLiteral assignment alias is rejected exactly once", () => {
		assertViolationCounts("let f; for ({ ensureFile: f } of vaultSyncs) {}", { "binding-alias": 1 });
	});

	console.log("\n--- ensureFile writer detector: indirect and transparent call routes ---");
	check("direct property alias is rejected exactly once", () => {
		assertViolationCounts("const f = vaultSync.ensureFile; f();", { "non-direct-access": 1 });
	});
	check("Function.call route is rejected exactly once", () => {
		assertViolationCounts("vaultSync.ensureFile.call(vaultSync, \"a.md\", \"A\");", {
			"non-direct-access": 1,
		});
	});
	check("Function.apply route is rejected exactly once", () => {
		assertViolationCounts("vaultSync.ensureFile.apply(vaultSync, [\"a.md\", \"A\"]);", {
			"non-direct-access": 1,
		});
	});
	check("parenthesized bare alias call is rejected exactly once", () => {
		assertViolationCounts("function bad() { (ensureFile)(\"a.md\", \"A\"); }", {
			"bare-alias-call": 1,
		});
	});
	check("transparent wrappers keep a direct property call inventoried", () => {
		const result = analyze(`
			function approved() {
				((((vaultSync.ensureFile as unknown as Function))!))("a.md", "A");
			}
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), ["synthetic/fixture.ts\u0000approved", 1]);
	});
	check("satisfies wrapper keeps a direct property call inventoried", () => {
		const result = analyze(`
			function approved() {
				(vaultSync.ensureFile satisfies Function)("a.md", "A");
			}
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), ["synthetic/fixture.ts\u0000approved", 1]);
	});
	check("angle-bracket type assertion keeps a direct property call inventoried", () => {
		const result = analyze(`
			function approved() {
				(<Function>vaultSync.ensureFile)("a.md", "A");
			}
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), ["synthetic/fixture.ts\u0000approved", 1]);
	});
	check("optional property and optional call routes stay direct", () => {
		const result = analyze(`
			function approved() {
				vaultSync?.ensureFile?.("a.md", "A");
			}
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), ["synthetic/fixture.ts\u0000approved", 1]);
	});

	console.log("\n--- ensureFile writer detector: computed property folding ---");
	check("parenthesized computed literal is inventoried", () => {
		const result = analyze(`function approved() { vaultSync[("ensureFile")]("a.md", "A"); }`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), ["synthetic/fixture.ts\u0000approved", 1]);
	});
	check("literal concatenation is inventoried", () => {
		const result = analyze(`function approved() { vaultSync["ensure" + "File"]("a.md", "A"); }`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), ["synthetic/fixture.ts\u0000approved", 1]);
	});
	check("source-local const concatenation and optional chain are inventoried", () => {
		const result = analyze(`
			const PREFIX = "ensure";
			const KEY = PREFIX + "File";
			function approved() { vaultSync?.[KEY]?.("a.md", "A"); }
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), ["synthetic/fixture.ts\u0000approved", 1]);
	});
	check("a shadowing non-const key prevents unsafe outer-const folding", () => {
		assertViolationCounts(`
			const KEY = "ensureFile";
			function bad(vault: VaultSync, KEY: string) { vault[KEY]("a.md", "A"); }
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("a shadowing function declaration prevents unsafe outer-const folding", () => {
		assertViolationCounts(`
			const KEY = "ensureFile";
			function bad(vault: VaultSync) {
				function KEY() {}
				vault[KEY]("a.md", "A");
			}
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("a shadowing destructured binding prevents unsafe outer-const folding", () => {
		assertViolationCounts(`
			const KEY = "ensureFile";
			function bad(vault: VaultSync, { KEY }: { KEY: string }) {
				vault[KEY]("a.md", "A");
			}
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("a block-nested var shadows at function scope", () => {
		assertViolationCounts(`
			const KEY = "ensureFile";
			function bad(vault: VaultSync) {
				{ var KEY: string; }
				vault[KEY]("a.md", "A");
			}
		`, { "unresolved-computed-vault-access": 1 });
	});

	console.log("\n--- ensureFile writer detector: unresolved computed VaultSync boundary ---");
	check("explicit VaultSync parameter rejects an unresolved computed route", () => {
		assertViolationCounts(`
			function bad(vault: VaultSync, key: string) { vault[key]("a.md", "A"); }
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("explicit VaultSync constructor property rejects an unresolved computed route", () => {
		assertViolationCounts(`
			class Owner {
				constructor(private readonly vault: VaultSync) {}
				bad(key: string) { this.vault[key]("a.md", "A"); }
			}
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("source-local alias of an exact VaultSync rejects an unresolved computed route", () => {
		assertViolationCounts(`
			function bad(vault: VaultSync, key: string) {
				const alias = vault;
				alias[key]("a.md", "A");
			}
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("non-null assertion on a nullable exact VaultSync rejects an unresolved route", () => {
		assertViolationCounts(`
			function bad(vault: VaultSync | null | undefined, key: string) {
				vault![key]("a.md", "A");
			}
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("as assertion to exact VaultSync rejects an unresolved computed route", () => {
		assertViolationCounts(`
			function bad(candidate: unknown, key: string) {
				(candidate as VaultSync)[key]("a.md", "A");
			}
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("angle assertion to exact VaultSync rejects an unresolved computed route", () => {
		assertViolationCounts(`
			function bad(candidate: unknown, key: string) {
				(<VaultSync>candidate)[key]("a.md", "A");
			}
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("satisfies exact VaultSync rejects an unresolved computed route", () => {
		assertViolationCounts(`
			function bad(candidate: unknown, key: string) {
				(candidate satisfies VaultSync)[key]("a.md", "A");
			}
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("Readonly VaultSync preserves the computed-access boundary", () => {
		assertViolationCounts(`
			function bad(vault: Readonly<VaultSync>, key: string) {
				vault[key]("a.md", "A");
			}
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("new VaultSync establishes the computed-access boundary", () => {
		assertViolationCounts(`
			function bad(key: string) { new VaultSync()[key]("a.md", "A"); }
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("class property initialized with VaultSync establishes this receiver", () => {
		assertViolationCounts(`
			class Owner {
				private readonly vault = new VaultSync();
				bad(key: string) { this.vault[key]("a.md", "A"); }
			}
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("getter return type establishes this receiver", () => {
		assertViolationCounts(`
			class Owner {
				get vault(): VaultSync { throw new Error("fixture"); }
				bad(key: string) { this.vault[key]("a.md", "A"); }
			}
		`, { "unresolved-computed-vault-access": 1 });
	});
	check("untyped receiver named vaultSync is outside the conservative boundary", () => {
		assert.deepEqual(analyze(`function ok(vaultSync, key) { vaultSync[key](); }`).violations, []);
	});
	check("explicit non-VaultSync receiver is outside the conservative boundary", () => {
		assert.deepEqual(analyze(`function ok(config: Record<string, Function>, key: string) { config[key](); }`).violations, []);
	});
	check("object containing VaultSync is not itself a VaultSync receiver", () => {
		assertViolationCounts(`
			function ok(container: { vault: VaultSync }, key: string) { container[key](); }
		`, {});
	});
	check("array of VaultSync is not itself a VaultSync receiver", () => {
		assertViolationCounts(`
			function ok(items: VaultSync[], key: string) { items[key](); }
		`, {});
	});
	check("factory returning VaultSync is not itself a VaultSync receiver", () => {
		assertViolationCounts(`
			function ok(factory: () => VaultSync, key: string) { factory[key](); }
		`, {});
	});
	check("mixed VaultSync union is outside the exact receiver boundary", () => {
		assertViolationCounts(`
			function ok(value: VaultSync | Record<string, Function>, key: string) { value[key](); }
		`, {});
	});
	check("mutable mixed receiver alias does not inherit stale initializer authority", () => {
		assertViolationCounts(`
			function ok(vault: VaultSync, config: Record<string, Function>, key: string) {
				let value: VaultSync | Record<string, Function> = vault;
				value = config;
				value[key]();
			}
		`, {});
	});
	check("plain constructor parameter does not establish a this property", () => {
		assertViolationCounts(`
			class Owner {
				[name: string]: unknown;
				constructor(vault: VaultSync) { void vault; }
				ok(key: string) { this.vault[key](); }
			}
		`, {});
	});

	console.log("\n--- ensureFile writer detector: lexical owner identity ---");
	check("duplicate method names in different classes retain distinct owner paths", () => {
		const result = analyze(`
			class First { approved() { this.vault.ensureFile("a.md", "A"); } }
			class Second { approved() { this.vault.ensureFile("b.md", "B"); } }
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual([...result.observedCounts.entries()].sort(), [
			["synthetic/fixture.ts\u0000First.approved", 1],
			["synthetic/fixture.ts\u0000Second.approved", 1],
		]);
	});
	check("relocating a method changes its lexical owner identity", () => {
		const before = analyze(`class Expected { approved() { this.vault.ensureFile("a.md", "A"); } }`);
		const after = analyze(`class Relocated { approved() { this.vault.ensureFile("a.md", "A"); } }`);
		assert.deepEqual(onlyObservedEntry(before), ["synthetic/fixture.ts\u0000Expected.approved", 1]);
		assert.deepEqual(onlyObservedEntry(after), ["synthetic/fixture.ts\u0000Relocated.approved", 1]);
	});
	check("returned object-literal method includes its lexical function owner", () => {
		const result = analyze(`
			function build() {
				return { approved() { vault.ensureFile("a.md", "A"); } };
			}
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), ["synthetic/fixture.ts\u0000build.approved", 1]);
	});
	check("assigned nested arrow becomes a distinct lexical writer owner", () => {
		const result = analyze(`
			class Owner {
				approved() {
					this.policyFence();
					const later = () => this.vault.ensureFile("a.md", "A");
					return later;
				}
			}
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), ["synthetic/fixture.ts\u0000Owner.approved.later", 1]);
		assert.equal(
			result.ownerEvidence.get("synthetic/fixture.ts\u0000Owner.approved")
				.calls.has("policyFence"),
			true,
		);
		assert.equal(
			result.ownerEvidence.get("synthetic/fixture.ts\u0000Owner.approved.later")
				.calls.has("policyFence"),
			false,
		);
	});
	check("top-level assigned arrow has a stable owner", () => {
		const result = analyze(`
			const approved = () => vault.ensureFile("a.md", "A");
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), ["synthetic/fixture.ts\u0000approved", 1]);
	});
	check("anonymous call argument is an exact nested owner", () => {
		const result = analyze(`
			class Owner {
				approved() {
					this.policyFence();
					queueMicrotask(() => this.vault.ensureFile("a.md", "A"));
				}
			}
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), [
			"synthetic/fixture.ts\u0000Owner.approved.queueMicrotask#arg0",
			1,
		]);
		assert.equal(
			result.ownerEvidence.get("synthetic/fixture.ts\u0000Owner.approved")
				.calls.has("policyFence"),
			true,
		);
		assert.equal(
			result.ownerEvidence.get("synthetic/fixture.ts\u0000Owner.approved.queueMicrotask#arg0")
				.calls.has("policyFence"),
			false,
		);
	});
	check("static call argument distinguishes repeated anonymous callbacks", () => {
		const result = analyze(`
			class Owner {
				approved() {
					consume("observe", () => true);
					consume("seed", () => this.vault.ensureFile("a.md", "A"));
				}
			}
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), [
			"synthetic/fixture.ts\u0000Owner.approved.consume#arg1[arg0=\"seed\"]",
			1,
		]);
	});
	check("branch ancestry distinguishes repeated anonymous callbacks", () => {
		const result = analyze(`
			class Owner {
				approved(flag: boolean, opId: string) {
					if (flag) {
						withActiveOpId(opId, () => true);
					} else {
						withActiveOpId(opId, () => this.vault.ensureFile("a.md", "A"));
					}
				}
			}
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), [
			"synthetic/fixture.ts\u0000Owner.approved.withActiveOpId#arg1[branch=else]",
			1,
		]);
	});
	check("binary-assigned arrow has a stable nested owner", () => {
		const result = analyze(`
			class Owner {
				approved() {
					let later: () => unknown;
					later = () => this.vault.ensureFile("a.md", "A");
					return later;
				}
			}
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), [
			"synthetic/fixture.ts\u0000Owner.approved.later",
			1,
		]);
	});
	check("static stage discriminator separates repeated commit callbacks", () => {
		const result = analyze(`
			class Owner {
				approved() {
					consume({ stage: "observe-only", commit: () => true });
					consume({
						stage: "seed-crdt",
						commit: () => this.vault.ensureFile("a.md", "A"),
					});
				}
			}
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), [
			"synthetic/fixture.ts\u0000Owner.approved.commit[stage=\"seed-crdt\"]",
			1,
		]);
	});
	check("nested object chains keep distinct complete owner paths", () => {
		const result = analyze(`
			const First = { api: { approved() { vault.ensureFile("a.md", "A"); } } };
			const Second = { api: { approved() { vault.ensureFile("b.md", "B"); } } };
		`);
		assert.deepEqual(result.violations, []);
		assert.deepEqual([...result.observedCounts.entries()].sort(), [
			["synthetic/fixture.ts\u0000First.api.approved", 1],
			["synthetic/fixture.ts\u0000Second.api.approved", 1],
		]);
	});
	check("distinct owner nodes cannot silently share one lexical key", () => {
		assertViolationCounts(`
			function build(flag: boolean) {
				if (flag) {
					const api = { approved() { vault.ensureFile("a.md", "A"); } };
					return api;
				}
				const api = { approved() { vault.ensureFile("b.md", "B"); } };
				return api;
			}
		`, { "owner-key-collision": 1 });
	});

	console.log("\n--- ensureFile writer detector: structural owner evidence ---");
	check("direct-owner call evidence is recorded structurally", () => {
		const result = analyze(`
			class Owner {
				approved() {
					this.policyFence();
					this.vault.ensureFile("a.md", "A");
				}
			}
		`);
		const evidence = result.ownerEvidence.get("synthetic/fixture.ts\u0000Owner.approved");
		assert.deepEqual([...evidence.calls], ["policyFence"]);
	});
	check("comments strings declarations and nested owners do not supply call evidence", () => {
		const result = analyze(`
			class Owner {
				approved() {
					// policyFence()
					const text = "policyFence()";
					const policyFence = () => true;
					function nested() { policyFence(); }
					const alsoNested = () => policyFence();
					this.vault.ensureFile("a.md", "A");
				}
			}
		`);
		const evidence = result.ownerEvidence.get("synthetic/fixture.ts\u0000Owner.approved");
		assert.equal(evidence.calls.has("policyFence"), false);
	});
	check("runtime identifier evidence excludes declaration-only and nested references", () => {
		const negative = analyze(`
			function approved() {
				const __KAOS_QA_HARNESS_ENABLED__ = true;
				function nested() { return __KAOS_QA_HARNESS_ENABLED__; }
				vault.ensureFile("a.md", "A");
			}
		`);
		assert.equal(
			negative.ownerEvidence.get("synthetic/fixture.ts\u0000approved")
				.runtimeIdentifiers.has("__KAOS_QA_HARNESS_ENABLED__"),
			false,
		);
		const positive = analyze(`
			declare const __KAOS_QA_HARNESS_ENABLED__: boolean;
			function approved() {
				if (typeof __KAOS_QA_HARNESS_ENABLED__ === "undefined") return;
				vault.ensureFile("a.md", "A");
			}
		`);
		assert.equal(
			positive.ownerEvidence.get("synthetic/fixture.ts\u0000approved")
				.runtimeIdentifiers.has("__KAOS_QA_HARNESS_ENABLED__"),
			true,
		);
	});

	console.log("\n--- ensureFile writer detector: non-binding object literals ---");
	check("ordinary object-literal property is allowed", () => {
		assert.deepEqual(analyze("const config = { ensureFile: f };").violations, []);
	});
	check("ordinary object-literal shorthand is allowed", () => {
		assert.deepEqual(analyze("const config = { ensureFile };").violations, []);
	});

	console.log("\n--- ensureFile writer detector: approved direct call inventory ---");
	check("a named owner direct call is inventoried without alias violations", () => {
		const result = analyze("function approved() { vaultSync.ensureFile(\"a.md\", \"A\"); }");
		assert.deepEqual(result.violations, []);
		assert.deepEqual(onlyObservedEntry(result), ["synthetic/fixture.ts\u0000approved", 1]);
	});

	console.log(`\nensure-file-writer-alias-regressions: ${passed} passed, ${failed} failed`);
	assert.equal(failed, 0, `${failed} ensureFile detector adversarial test(s) failed`);
	return { passed, failed };
}

const isMain = process.argv[1]
	&& fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`));

if (isMain) {
	try {
		runEnsureFileWriterDetectorAdversarialTests();
	} catch {
		process.exitCode = 1;
	}
}
