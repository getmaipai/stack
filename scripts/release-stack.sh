#!/usr/bin/env bash
# ADMIN-10: packages one Stack release for people who run the Stack with
# no Home. It builds the binary directory with scripts/build-binary.sh
# (binary, admin-ui/, migrations/, ort-wasm/, backend-src/), then writes
# two files into release/:
#
#   maipai-stack-<tag>-<platform>-<arch>.tar.gz   the build, one folder inside
#   SHA256SUMS                                    one line per tarball
#
# It does NOT tag, push or publish anything. Publishing the files as a
# GitHub release is the owner's call. scripts/install.sh downloads exactly
# these two names.
#
#   bash scripts/release-stack.sh v0.1.0
#   BUILD_DIR=/tmp/built bash scripts/release-stack.sh v0.1.0   # reuse an existing build (skips the compile)
#   RELEASE_DIR=/tmp/out bash scripts/release-stack.sh v0.1.0
#   SKIP_VERIFY=1 is passed to build-binary.sh unless set (the live verify downloads models; run it by hand)
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:-}"
case "$TAG" in
  v[0-9]*) ;;
  *) echo "Give the release name, like v0.1.0: bash scripts/release-stack.sh v0.1.0"; exit 2 ;;
esac
case "$TAG" in *[!A-Za-z0-9._-]*) echo "The release name may only hold letters, digits, dots, dashes and underscores."; exit 2 ;; esac

PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in x86_64) ARCH="x64" ;; aarch64) ARCH="arm64" ;; esac
RELEASE_DIR="${RELEASE_DIR:-release}"
mkdir -p "$RELEASE_DIR"
RELEASE_DIR="$(cd "$RELEASE_DIR" && pwd)"

if [ -n "${BUILD_DIR:-}" ]; then
  BUILD_DIR="$(cd "$BUILD_DIR" && pwd)"
else
  BUILD_DIR="$(mktemp -d)/maipai-stack"
  OUT_DIR="$BUILD_DIR" SKIP_VERIFY="${SKIP_VERIFY:-1}" REQUIRE_ADMIN_UI=1 bash scripts/build-binary.sh
fi
[ -x "$BUILD_DIR/maipai-stack-${PLATFORM}-${ARCH}" ] || { echo "No binary maipai-stack-${PLATFORM}-${ARCH} in $BUILD_DIR. Build first with scripts/build-binary.sh."; exit 1; }
for part in admin-ui migrations backend-src; do [ -d "$BUILD_DIR/$part" ] || { echo "$BUILD_DIR has no $part/. The build is incomplete; run scripts/build-binary.sh again."; exit 1; }; done

TARBALL="maipai-stack-${TAG}-${PLATFORM}-${ARCH}.tar.gz"
# One top folder named for the tag, so extracting never spills into the current directory.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -RP "$BUILD_DIR" "$STAGE/maipai-stack-${TAG}"
echo "$TAG" > "$STAGE/maipai-stack-${TAG}/VERSION"
COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$RELEASE_DIR/$TARBALL" "maipai-stack-${TAG}"

# SHA256SUMS keeps lines from other platforms' tarballs of the same tag.
SUMS="$RELEASE_DIR/SHA256SUMS"
touch "$SUMS"
grep -v " $TARBALL\$" "$SUMS" > "$SUMS.tmp" || true
if command -v sha256sum >/dev/null 2>&1; then (cd "$RELEASE_DIR" && sha256sum "$TARBALL") >> "$SUMS.tmp"
else (cd "$RELEASE_DIR" && shasum -a 256 "$TARBALL") >> "$SUMS.tmp"; fi
mv "$SUMS.tmp" "$SUMS"
cp scripts/install.sh "$RELEASE_DIR/install.sh"

echo "Release files in $RELEASE_DIR (nothing tagged, pushed or published):"
ls -l "$RELEASE_DIR/$TARBALL" "$SUMS" "$RELEASE_DIR/install.sh"
cat "$SUMS"
