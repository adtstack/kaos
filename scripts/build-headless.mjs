#!/usr/bin/env node
import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["src/headless/cli.ts"],
	outfile: "dist/kaos-headless.mjs",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node18",
	sourcemap: true,
	banner: {
		js: "#!/usr/bin/env node",
	},
});
