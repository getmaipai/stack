#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
mkdir -p "$DIST"
VERSION="${VERSION:-$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)}"

target="darwin-arm64"
rust_triple="aarch64-apple-darwin"

build_sidecar() {
  (cd "$ROOT/frontend" && bun run build)
  local output="$DIST/maipai-stack-$target"
  rm -f "$output"
  bun build --compile "$ROOT/scripts/release-entry.ts" --outfile "$output" --asset-naming='[name].[ext]'
  chmod 755 "$output"
  mkdir -p "$ROOT/desktop/src-tauri/binaries"
  cp "$output" "$ROOT/desktop/src-tauri/binaries/maipai-stack-$rust_triple"
  chmod 755 "$ROOT/desktop/src-tauri/binaries/maipai-stack-$rust_triple"
}

if [[ "${1:-}" == "--sidecar-only" ]]; then
  build_sidecar
  echo "Built sidecar $ROOT/desktop/src-tauri/binaries/maipai-stack-$rust_triple"
  exit 0
fi

(cd "$ROOT/frontend" && bun run build)

output="$DIST/maipai-stack-$target"
rm -f "$output"
bun build --compile "$ROOT/scripts/release-entry.ts" --outfile "$output" --asset-naming='[name].[ext]'
chmod 755 "$output"
(cd "$ROOT/frontend" && bun run build >/dev/null)
mkdir -p "$ROOT/desktop/src-tauri/binaries"
cp "$output" "$ROOT/desktop/src-tauri/binaries/maipai-stack-$rust_triple"
chmod 755 "$ROOT/desktop/src-tauri/binaries/maipai-stack-$rust_triple"
(cd "$DIST" && shasum -a 256 "$(basename "$output")" > SHA256SUMS)

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "Release $VERSION (dry run)"
  find "$DIST" -maxdepth 1 -type f -print0 | xargs -0 -n1 basename | sort
fi

checksum="$(awk '{print $1}' "$DIST/SHA256SUMS")"
size="$(stat -f '%z' "$output" 2>/dev/null || stat -c '%s' "$output")"
for kind in app engines models; do
  cat > "$DIST/$kind.json" <<JSON
{"version":"$VERSION","notes":"See the release notes.","pub_date":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","platforms":{"darwin-arm64":{"url":"https://github.com/getmaipai/stack/releases/download/v$VERSION/$(basename "$output")","sha256":"$checksum","size":$size,"signature":"unsigned"}}}
JSON
done
cp "$ROOT/installer/install.sh" "$DIST/install.sh"
chmod 755 "$DIST/install.sh"
if [[ "${1:-}" == "--dry-run" ]]; then echo "Dry run complete"; fi

echo "Built $output"
cat "$DIST/SHA256SUMS"
echo "Release $VERSION artifacts are in $DIST"
