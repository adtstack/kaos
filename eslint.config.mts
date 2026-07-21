import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				project: "./tsconfig.eslint.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		files: ["**/*.mjs"],
		languageOptions: {
			globals: {
				...globals.node,
				fetch: "readonly",
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			"no-undef": "off",
			"obsidianmd/ui/sentence-case": [
				"error",
				{
					enforceCamelCaseLower: true,
					ignoreWords: ["Cloudflare", "KAOS"],
				},
			],
		},
	},
	{
		files: ["package.json"],
		rules: {
			"depend/ban-dependencies": "off",
		},
	},
	{
		files: ["server/src/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.serviceworker,
			},
			parserOptions: {
				project: "./server/tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		files: ["server/tests/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.serviceworker,
			},
			parserOptions: {
				project: "./server/tsconfig.eslint.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// Test programs intentionally report progress on stdout.
			"no-console": "off",
		},
	},
	{
		files: ["server/src/concurrency.ts"],
		rules: {
			// This build-boundary copy must stay byte-identical to the canonical
			// implementation, whose noUncheckedIndexedAccess setting requires it.
			"@typescript-eslint/no-unnecessary-type-assertion": "off",
		},
	},
	{
		files: ["src/headless-host/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.browser,
			},
		},
		rules: {
			// The headless host is a Node.js compatibility runtime, not an
			// Obsidian-renderer entry point. These plugin-only restrictions are
			// false positives at this boundary.
			"import/no-nodejs-modules": "off",
			"no-console": "off",
			"no-restricted-globals": "off",
			"obsidianmd/hardcoded-config-path": "off",
		},
	},
	{
		files: [
			"src/headless-host/polyfills.ts",
			"src/headless-host/obsidianShim.ts",
			"src/headless-host/core/dom.ts",
			"src/headless-host/core/events.ts",
			"src/headless-host/core/plugin.ts",
			"src/headless-host/core/workspace.ts",
			"src/headless-host/kaos/bootKaosPlugin.ts",
			"src/headless-host/kaos/config.ts",
		],
		rules: {
			// These files deliberately reflect over the dynamically loaded Obsidian
			// bundle and install DOM/runtime shims. Runtime guards are the type
			// boundary; forcing static member types here would misrepresent it.
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/no-base-to-string": "off",
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"server/dist",
		"server/.wrangler",
		"server/.partykit",
		"tests",
		// QA harness, analyzers, and run artifacts.
		// `qa/` contains both .ts sources and emitted .js artifacts (e.g.
		// qa/analyzers/analyzer.js sits next to qa/analyzers/analyzer.ts).
		// The emitted .js files have no parserOptions.project entry in
		// tsconfig.eslint.json, which causes typed lint rules
		// (@typescript-eslint/no-deprecated and friends) to throw on rule
		// load and abort the entire eslint run. The QA harness is a
		// separate workspace: the .ts sources are linted there if needed,
		// and the emitted .js artifacts are not source we lint. Same for
		// qa-runs/ which holds run output bundles and reports.
		"qa",
		"qa-runs",
		"manifest.json",
		"esbuild.config.mjs",
		"eslint.config.mts",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		"telemetry.js",
	]),
);
