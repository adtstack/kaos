/**
 * Build script for the KAOS QA Harness plugin.
 *
 * Usage:
 *   node qa/obsidian-harness/esbuild.mjs             # dev watch
 *   node qa/obsidian-harness/esbuild.mjs production  # production build
 *
 * Output: qa/obsidian-harness/main.js
 */

import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
	entryPoints: ["qa/obsidian-harness/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	define: {
		// This bundle is the mutation harness itself. Keep its dangerous fixture
		// methods closed everywhere else, but make the QA intent explicit here.
		"__KAOS_QA_HARNESS_ENABLED__": "true",
	},
	outfile: "qa/obsidian-harness/main.js",
	minify: prod,
});

if (prod) {
	await ctx.rebuild();
	process.exit(0);
} else {
	await ctx.watch();
}
