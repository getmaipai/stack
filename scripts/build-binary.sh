#!/usr/bin/env bash
# HOME-STACK-01: compiles the Stack into one binary Home's installer can
# place and run, `bun build --compile` from the backend entry
# (src/index.ts), which dispatches `serve`/`install-service`/`start`/
# `stop`/`status`/`uninstall-service --remove-data` (daemon.ts) and
# `speech-worker` (index.ts's own dispatch) from one file.
#
# The binary alone is not enough to run: db/index.ts's migrations read
# a real folder from disk by a path relative to the binary's own
# location, not to anything `bun build --compile` embeds automatically
# (drizzle's migrator uses plain node:fs, which cannot see into the
# compiled binary's virtual filesystem) - found live building this
# script. So this script's output is a directory, not a bare file: the
# binary plus real sibling directories. Whoever places the binary
# (Home's install.sh) places all of it together.
#
# ONE ROLE IS DELIBERATELY NOT SERVED BY THE BINARY ITSELF: stt.
# speech/sherpa.ts's own loadModule() comment has the full story - a
# genuine Bun bundler bug (getmaipai/stack#8), not anything in this
# repo's own code, where the native STT binding's require() fails to
# resolve at all once a compiled binary also contains the daemon's
# graph. So this script ALSO ships `backend-src/`, a real, dereferenced
# copy of `backend/` (source and node_modules both - `cp -RL`, not a
# bare `cp -R`, since bun's own install layout is symlinks into a
# content-addressed store that would dangle once moved), and
# lib/supervisor.ts's speechWorkerCommand() runs the stt worker as a
# real `bun run backend-src/src/index.ts speech-worker ...` instead of
# re-invoking the compiled binary - the exact shape that works, proven
# by this script's own live verify step below actually transcribing
# real audio, not just checking that the daemon started. `STACK_BUN_BIN`
# names which `bun` that is; Home's installer sets it to the same one it
# already installs for its own frontend build.
#
#   bash scripts/build-binary.sh              # ./dist, this machine's platform/arch
#   OUT_DIR=/tmp/x bash scripts/build-binary.sh
#   SKIP_VERIFY=1 bash scripts/build-binary.sh # compile only, no live checks at all
#   SKIP_STT_VERIFY=1 bash scripts/build-binary.sh  # live daemon + healthz, skip the real stt download/transcribe
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="${OUT_DIR:-dist}"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in x86_64) ARCH="x64" ;; aarch64) ARCH="arm64" ;; esac
BINARY_NAME="maipai-stack-${PLATFORM}-${ARCH}"
BUN_BIN="${STACK_BUN_BIN:-$(command -v bun)}"

echo "== backend: install"
(cd backend && bun install --silent)

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
# Resolved to absolute right after creation: the compile step below
# runs inside `(cd backend && ...)`, so a relative $OUT_DIR (the
# default, "dist") needs to be re-based from there - `../$OUT_DIR` did
# that, but silently produced a broken path when a caller (Home's own
# install.sh, which always passes one) gave an absolute $OUT_DIR
# instead, prepending a stray "../" onto an absolute path. Resolving
# once, here, means the compile step below needs no relative-vs-
# absolute logic of its own at all. Found live wiring HOME-STACK-01's
# home-side install.sh into this script for real.
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

echo "== compile: $BINARY_NAME"
(cd backend && bun build src/index.ts --compile --outfile "$OUT_DIR/$BINARY_NAME")

echo "== migrations (sibling directory, see this script's own header)"
cp -R backend/src/db/migrations "$OUT_DIR/migrations"

echo "== backend-src (vendored, dereferenced - the stt worker's own real bun run target, see this script's own header)"
mkdir -p "$OUT_DIR/backend-src"
for entry in src node_modules package.json bunfig.toml tsconfig.json; do
  [ -e "backend/$entry" ] && cp -RL "backend/$entry" "$OUT_DIR/backend-src/$entry"
done

echo "== done: $OUT_DIR/$BINARY_NAME"
du -sh "$OUT_DIR"/* 2>/dev/null

if [ "${SKIP_VERIFY:-0}" = "1" ]; then exit 0; fi

echo
echo "== live verify: serve + /healthz on a scratch data directory"
VERIFY_DATA="$(mktemp -d)"
VERIFY_LOG="$VERIFY_DATA/serve.log"
VERIFY_PORT=8799
STACK_DATA_DIR="$VERIFY_DATA" PORT="$VERIFY_PORT" STACK_BUN_BIN="$BUN_BIN" "$OUT_DIR/$BINARY_NAME" serve >"$VERIFY_LOG" 2>&1 &
VERIFY_PID=$!
cleanup() { kill "$VERIFY_PID" 2>/dev/null || true; rm -rf "$VERIFY_DATA"; }
trap cleanup EXIT
for _ in $(seq 1 20); do curl -sf "http://127.0.0.1:$VERIFY_PORT/healthz" >/dev/null 2>&1 && break; sleep 0.25; done
if ! curl -sf "http://127.0.0.1:$VERIFY_PORT/healthz"; then
  echo; echo "the compiled binary did not answer /healthz"; tail -30 "$VERIFY_LOG"; exit 1
fi
echo; echo "healthz OK, roles: $(curl -s "http://127.0.0.1:$VERIFY_PORT/stack/v1/roles" | python3 -c "import json,sys;print([r['id'] for r in json.load(sys.stdin)['roles']])")"

if [ "${SKIP_STT_VERIFY:-0}" = "1" ]; then exit 0; fi

echo
echo "== live verify: stt actually transcribes, through STACK_BUN_BIN + backend-src (real downloads, checksums verified)"
CLIP="backend/src/speech/fixtures/clover-two-seconds.wav"
PINS="$(curl -s "http://127.0.0.1:$VERIFY_PORT/stack/v1/models/catalog")"
for ID in silero-vad moonshine-tiny-en-int8; do
  BODY="$(echo "$PINS" | python3 -c "
import json,sys
m=[m for m in json.load(sys.stdin)['models'] if m['id']==sys.argv[1]][0]
b={'id':m['id'],'role':m['role'],'url':m['download']['url'],'sha256':m['download']['sha256'],'approx_bytes':m['download']['approx_bytes'],'licence':m['license'],'revision':m['revision']}
b.update({k:m[k] for k in ('repo','engine','component') if m.get(k) is not None})
if m['download'].get('archive'): b['archive']=True
print(json.dumps(b))" "$ID")"
  JOB="$(curl -s -X POST "http://127.0.0.1:$VERIFY_PORT/stack/v1/models" -H 'content-type: application/json' -d "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['job'])")"
  for _ in $(seq 1 240); do
    STATE="$(curl -s "http://127.0.0.1:$VERIFY_PORT/stack/v1/jobs/$JOB" | python3 -c "import json,sys;print(json.load(sys.stdin)['job']['state'])")"
    case "$STATE" in done|failed|cancelled) break;; esac
    sleep 0.5
  done
  echo "$ID -> $STATE"
  if [ "$STATE" != "done" ]; then echo "the stt package install job did not finish"; exit 1; fi
done
RESPONSE="$(curl -s -w '\n%{http_code}' -X POST "http://127.0.0.1:$VERIFY_PORT/v1/audio/transcriptions" -F "file=@$CLIP;type=audio/wav")"
STATUS="$(echo "$RESPONSE" | tail -1)"
BODY="$(echo "$RESPONSE" | sed '$d')"
echo "transcription: $STATUS $BODY"
if [ "$STATUS" != "200" ]; then echo "stt did not actually work - this is what backend-src + STACK_BUN_BIN exist to fix (getmaipai/stack#8)"; exit 1; fi
