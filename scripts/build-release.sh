#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
mkdir -p "$DIST"

(cd "$ROOT/frontend" && bun run build)

target="darwin-arm64"
output="$DIST/maipai-stack-$target"
rm -f "$output"
bun build --compile "$ROOT/scripts/release-entry.ts" --outfile "$output" --asset-naming='[name].[ext]'
chmod 755 "$output"
(cd "$DIST" && shasum -a 256 "$(basename "$output")" > SHA256SUMS)

echo "Built $output"
cat "$DIST/SHA256SUMS"
echo "Future target names: maipai-stack-linux-x64 and maipai-stack-windows-x64"
