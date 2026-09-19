#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
mkdir -p "$DIST"
VERSION="${VERSION:-$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)}"

target="darwin-arm64"
rust_triple="aarch64-apple-darwin"
bundle_dir="$ROOT/desktop/src-tauri/target/release/bundle"
app_name="MaiPai Stack.app"
app_archive="MaiPai-Stack-$target.zip"

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

build_sidecar
(cd "$ROOT/desktop" && bun run build)

app_path="$bundle_dir/macos/$app_name"
app_archive_path="$DIST/$app_archive"
rm -f "$app_archive_path" "$DIST/MaiPai-Stack.dmg"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$app_archive_path"
if [[ -f "$bundle_dir/dmg/MaiPai Stack_${VERSION}_aarch64.dmg" ]]; then
  cp "$bundle_dir/dmg/MaiPai Stack_${VERSION}_aarch64.dmg" "$DIST/MaiPai-Stack.dmg"
fi

output="$DIST/maipai-stack-$target"
cp "$ROOT/installer/install.sh" "$DIST/install.sh"
chmod 755 "$DIST/install.sh"
checksum_files=("$(basename "$output")" "$app_archive" install.sh)
if [[ -f "$DIST/MaiPai-Stack.dmg" ]]; then
  checksum_files+=(MaiPai-Stack.dmg)
fi
(cd "$DIST" && shasum -a 256 "${checksum_files[@]}" > SHA256SUMS)

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "Release $VERSION (dry run)"
  find "$DIST" -maxdepth 1 -type f -print0 | xargs -0 -n1 basename | sort
fi

sidecar_checksum="$(awk '$2 == "maipai-stack-darwin-arm64" { print $1 }' "$DIST/SHA256SUMS")"
sidecar_size="$(stat -f '%z' "$output" 2>/dev/null || stat -c '%s' "$output")"
app_checksum="$(awk -v archive="$app_archive" '$2 == archive { print $1 }' "$DIST/SHA256SUMS")"
app_size="$(stat -f '%z' "$app_archive_path" 2>/dev/null || stat -c '%s' "$app_archive_path")"
cat > "$DIST/app.json" <<JSON
{"version":"$VERSION","notes":"See the release notes.","pub_date":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","platforms":{"darwin-arm64":{"url":"https://github.com/getmaipai/stack/releases/download/v$VERSION/$app_archive","sha256":"$app_checksum","size":$app_size,"signature":"unsigned"}}}
JSON
for kind in engines models; do
  cat > "$DIST/$kind.json" <<JSON
{"version":"$VERSION","notes":"See the release notes.","pub_date":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","platforms":{"darwin-arm64":{"url":"https://github.com/getmaipai/stack/releases/download/v$VERSION/$(basename "$output")","sha256":"$sidecar_checksum","size":$sidecar_size,"signature":"unsigned"}}}
JSON
done
if [[ "${1:-}" == "--dry-run" ]]; then echo "Dry run complete"; fi

echo "Built $output"
cat "$DIST/SHA256SUMS"
echo "Release $VERSION artifacts are in $DIST"
