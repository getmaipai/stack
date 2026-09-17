#!/bin/sh
set -eu

# The installer contacts only these release assets (the base URL is
# overrideable for offline tests):
# https://github.com/getmaipai/stack/releases/latest/download/maipai-stack-darwin-arm64
# https://github.com/getmaipai/stack/releases/latest/download/SHA256SUMS

release_base=${MAIPAI_STACK_RELEASE_BASE_URL:-https://github.com/getmaipai/stack/releases/latest/download}
stack_home=${MAIPAI_STACK_HOME:-"$HOME/.maipai/stack"}
binary="$stack_home/bin/maipai-stack"
health_url=${MAIPAI_STACK_HEALTH_URL:-http://127.0.0.1:8770}

if [ "${1:-}" = "--uninstall" ]; then
  if [ -x "$binary" ]; then
    "$binary" uninstall-service
    rm -f "$binary"
  fi
  echo "MaiPai Stack removed. Your data stays in $stack_home/data."
  exit 0
fi

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "This installer supports macOS on Apple silicon (arm64) today." >&2
  exit 1
fi

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/maipai-stack-install.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM
archive="$tmpdir/maipai-stack-darwin-arm64"
sums="$tmpdir/SHA256SUMS"
curl --fail --location --silent --show-error "$release_base/maipai-stack-darwin-arm64" -o "$archive"
curl --fail --location --silent --show-error "$release_base/SHA256SUMS" -o "$sums"
expected=$(awk '$2 == "maipai-stack-darwin-arm64" || $2 == "*maipai-stack-darwin-arm64" { print $1; exit }' "$sums")
actual=$(shasum -a 256 "$archive" | awk '{ print $1 }')
if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
  echo "The downloaded Stack binary failed its checksum." >&2
  exit 1
fi

mkdir -p "$stack_home/bin" "$stack_home/data"
install -m 755 "$archive" "$binary"
STACK_DATA_DIR="$stack_home/data" "$binary" install-service

i=0
while [ "$i" -lt 60 ]; do
  if curl --fail --silent "$health_url/healthz" >/dev/null 2>&1; then
    STACK_DATA_DIR="$stack_home/data" "$binary" open
    echo "MaiPai Stack is running at $health_url"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
echo "The Stack service did not become healthy." >&2
exit 1
