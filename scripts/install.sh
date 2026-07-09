#!/usr/bin/env bash
set -euo pipefail

REPO="${KAOS_RELEASE_REPO:-adtstack/kaos}"
TAG="${KAOS_RELEASE_TAG:-latest}"

if [ "$TAG" = "latest" ]; then
	RELEASE_BASE_URL="https://github.com/${REPO}/releases/latest/download"
else
	RELEASE_BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
fi

if [ ! -r /dev/tty ]; then
	echo "KAOS headless install is interactive and requires a TTY." >&2
	exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
	echo "curl is required to install KAOS headless." >&2
	exit 1
fi

if ! command -v node >/dev/null 2>&1; then
	echo "Node.js 20 or newer is required before installing KAOS headless." >&2
	exit 1
fi

node -e 'const major = Number.parseInt(process.versions.node.split(".")[0] || "0", 10); if (!Number.isFinite(major) || major < 20) { console.error(`Node.js 20 or newer is required. Current: ${process.version}`); process.exit(1); }'

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kaos-headless-install.XXXXXX")"
cleanup() {
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT

MANIFEST="$TMP_DIR/kaos-headless-user-manifest.json"
KAOS_CLI="$TMP_DIR/kaosctl.mjs"

curl -fsSL "${RELEASE_BASE_URL}/kaos-headless-user-manifest.json" -o "$MANIFEST"
curl -fsSL "${RELEASE_BASE_URL}/kaosctl.mjs" -o "$KAOS_CLI"

node -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const [manifestPath, assetPath] = process.argv.slice(1);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const expected = manifest.assets && manifest.assets["kaosctl.mjs"] && manifest.assets["kaosctl.mjs"].sha256;
if (!expected) {
	console.error("Release manifest is missing the KAOS CLI checksum.");
	process.exit(1);
}
const actual = createHash("sha256").update(readFileSync(assetPath)).digest("hex");
if (actual !== expected) {
	console.error(`KAOS CLI checksum mismatch: expected ${expected}, got ${actual}`);
	process.exit(1);
}
' "$MANIFEST" "$KAOS_CLI"

chmod +x "$KAOS_CLI"
exec node -- "$KAOS_CLI" install --release-base-url "$RELEASE_BASE_URL" --release-manifest "$MANIFEST"
