#!/usr/bin/env bash
# STACK-96: pin and rollback proven live, through the public routes.
# Starts the daemon on loopback with a clean scratch data directory,
# installs the pinned engine and model (real downloads), gets a chat
# answer, stages the same build under a second tag, swaps to it with the
# drain and post-load check, rolls back, then proves a build whose
# post-load check fails is relinked and fixed through the health route,
# and that a wrong checksum is refused. Prints a transcript with timings
# to stdout; touches nothing outside the repo and data-scratch/.
#
#   bash scripts/prove-pin-rollback.sh            # port 8771
#   PORT=8790 bash scripts/prove-pin-rollback.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8771}"
BASE="http://127.0.0.1:$PORT"
DATA="${DATA_DIR:-$PWD/data-scratch}"
LOG="$DATA/daemon.log"
KEEP_DATA="${KEEP_DATA:-0}"

port_free() { python3 -c "import socket,sys;s=socket.socket();s.settimeout(0.2)
try: s.bind(('127.0.0.1',int(sys.argv[1]))); s.close(); sys.exit(0)
except OSError: sys.exit(1)" "$1"; }
port_free "$PORT" || { echo "port $PORT is in use; pick another with PORT="; exit 1; }
rm -rf "$DATA"; mkdir -p "$DATA"

# The daemon leads its own process group, so the SIGKILL fallback takes a
# spawned engine with it instead of orphaning it on its port and memory.
STACK_DATA_DIR="$DATA" PORT="$PORT" python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' bun run backend/src/index.ts serve >"$LOG" 2>&1 &
PID=$!
echo "daemon pid $PID on port $PORT, data $DATA"
stop_daemon() {
  # SIGTERM to the daemon alone (it drains and stops its engines); after
  # 10 s the whole group is killed, engine included.
  kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  kill -9 -- "-$PID" 2>/dev/null || true
}
cleanup() {
  stop_daemon
  if port_free "$PORT"; then echo "port $PORT free after stop"; else echo "port $PORT still held after stop"; fi
  if [ "$KEEP_DATA" != "1" ]; then rm -rf "$DATA"; echo "scratch data removed"; fi
}
trap cleanup EXIT

for _ in $(seq 1 40); do curl -sf "$BASE/healthz" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "$BASE/healthz" >/dev/null || { echo "daemon did not answer"; tail -20 "$LOG"; exit 1; }

now() { python3 -c 'import time;print(time.time())'; }
since() { python3 -c "import time;print(f'{time.time()-$1:.2f}s')"; }
json() { curl -s -X "$1" "$BASE$2" -H 'content-type: application/json' ${3:+-d "$3"}; }
field() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1"; }
wait_job() {
  local id="$1" state
  while :; do
    state="$(json GET "/stack/v1/jobs/$id" | field "['job']['state']")"
    case "$state" in done|failed|cancelled) echo "$state"; return;; esac
    sleep 0.5
  done
}
step() { echo; echo "== $*"; }

step "1. the catalog pin"
PIN="$(json GET /stack/v1/models/catalog | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['models'][0]))")"
echo "$PIN" | python3 -c "import json,sys;m=json.load(sys.stdin);print('model', m['id'], m['revision'], m['download']['sha256'][:12], m['download']['approx_bytes'], 'bytes')"

step "2. install the pinned engine (real download)"
T=$(now)
JOB="$(json POST /stack/v1/engines/llama-server/install '{}' | field "['job']")"
echo "job $JOB -> $(wait_job "$JOB") in $(since $T)"
json GET /stack/v1/engines | python3 -c "import json,sys;[print('engine', e['id'], 'installed' if e['installed'] else 'not installed', 'current' if e['current'] else e['stateReason']) for e in json.load(sys.stdin)['engines'] if e['matchesThisMachine']]"
CURRENT_TAG="$(json GET /stack/v1/updates | field "['engines'][0]['installed']")"
echo "current link: $CURRENT_TAG"

step "3. install the pinned model (real download, checksum verified)"
T=$(now)
BODY="$(echo "$PIN" | python3 -c "import json,sys;m=json.load(sys.stdin);b={'id':m['id'],'role':m['role'],'url':m['download']['url'],'sha256':m['download']['sha256'],'approx_bytes':m['download']['approx_bytes'],'licence':m['license'],'revision':m['revision']}
b.update({k:m[k] for k in ('repo','engine') if m.get(k) is not None})
print(json.dumps(b))")"
JOB="$(json POST /stack/v1/models "$BODY" | field "['job']")"
echo "job $JOB -> $(wait_job "$JOB") in $(since $T)"
json GET /stack/v1/models | python3 -c "import json,sys;[print('model', m['id'], m['state'], 'sha256', (m['sha256'] or '')[:12], 'verified', m['verifiedAt'] is not None, m['sizeBytes'], 'bytes') for m in json.load(sys.stdin)['models']]"

step "4. first chat answer through the public route (load plus first reply)"
T=$(now)
curl -s -i -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' -d '{"model":"chat","messages":[{"role":"user","content":"Reply with just the word OK."}],"max_tokens":8}' | sed -n '1p;/^x-maipai/p' | tr -d '\r'
echo "in $(since $T)"
json GET /stack/v1/roles | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['roles'] if x['id']=='chat'][0];print('chat state', r['state']['state'], 'checkedAt', r['state'].get('checkedAt'), 'measured footprint', r['model']['measuredFootprintBytes'], 'context', r['model']['measuredContextLength'])"

step "5. stage the same build under a second tag (no engine index upstream yet)"
ARCHIVE="$(json GET /stack/v1/engines | python3 -c "import json,sys;print([e['id'] for e in json.load(sys.stdin)['engines'] if e['matchesThisMachine']][0])")"
STAGE="$(bun -e "import { ENGINE_BINARIES } from './backend/src/lib/engineCatalog'; const pin = ENGINE_BINARIES.find((p) => p.id === '$ARCHIVE'); console.log(JSON.stringify({ tag: 'b10797-proof', url: pin.archive.url, sha256: pin.archive.sha256, size: pin.archive.approxBytes }))")"
T=$(now)
JOB="$(json POST /stack/v1/engines/llama-server/install "$STAGE" | field "['job']")"
echo "staged b10797-proof: job $JOB -> $(wait_job "$JOB") in $(since $T)"
echo "current link still: $(json GET /stack/v1/updates | field "['engines'][0]['installed']")"

step "6. swap to the staged tag: drain, relink, post-load check"
T=$(now)
json PUT /stack/v1/engines/llama-server/current '{"tag":"b10797-proof"}'; echo " in $(since $T)"
echo "current link: $(json GET /stack/v1/updates | field "['engines'][0]['installed']")"
curl -s -i -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' -d '{"model":"chat","messages":[{"role":"user","content":"Reply with just the word OK."}],"max_tokens":8}' | sed -n '1p;/^x-maipai-engine/p' | tr -d '\r'

step "7. roll back to the previous tag"
T=$(now)
json POST /stack/v1/updates/engines/llama-server/rollback "{\"tag\":\"$CURRENT_TAG\"}"; echo " in $(since $T)"
echo "current link: $(json GET /stack/v1/updates | field "['engines'][0]['installed']")"
curl -s -o /dev/null -w "chat after rollback: HTTP %{http_code}\n" -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' -d '{"model":"chat","messages":[{"role":"user","content":"Reply with just the word OK."}],"max_tokens":8}'

step "8. a build whose post-load check fails is relinked and fixed through health"
STAGE_BROKEN="$(echo "$STAGE" | python3 -c "import json,sys;d=json.load(sys.stdin);d['tag']='b10797-broken';print(json.dumps(d))")"
JOB="$(json POST /stack/v1/engines/llama-server/install "$STAGE_BROKEN" | field "['job']")"
echo "staged b10797-broken: $(wait_job "$JOB")"
# The harness breaks the staged binary on disk (a truncated download the
# checksum would have caught cannot be produced through the API, so this
# stands in for a build that starts and fails its post-load check).
: > "$DATA/engines/llama-server/b10797-broken/llama-server"
T=$(now)
json PUT /stack/v1/engines/llama-server/current '{"tag":"b10797-broken"}'; echo " in $(since $T)"
echo "current link after the failed swap: $(json GET /stack/v1/updates | field "['engines'][0]['installed']")"
json GET /stack/v1/health | python3 -c "import json,sys;[print('health', h['code'], h['severity'], 'fix', h.get('fix',{}).get('action')) for h in json.load(sys.stdin)['health']]"
# The previous build is linked back at once, so chat answers again
# before the fix runs; the fix clears the health item and the reason.
curl -s -o /dev/null -w "chat after the relink: HTTP %{http_code}\n" -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' -d '{"model":"chat","messages":[{"role":"user","content":"Reply with just the word OK."}],"max_tokens":8}'
T=$(now)
json POST /stack/v1/health/failed-swap/fix; echo " in $(since $T)"
curl -s -o /dev/null -w "chat after the fix: HTTP %{http_code}\n" -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' -d '{"model":"chat","messages":[{"role":"user","content":"Reply with just the word OK."}],"max_tokens":8}'
echo "current link: $(json GET /stack/v1/updates | field "['engines'][0]['installed']")"

step "9. a wrong checksum is refused before anything is extracted"
STAGE_BAD="$(echo "$STAGE" | python3 -c "import json,sys;d=json.load(sys.stdin);d['tag']='b10797-bad';d['sha256']='0'*64;print(json.dumps(d))")"
JOB="$(json POST /stack/v1/engines/llama-server/install "$STAGE_BAD" | field "['job']")"
echo "staged b10797-bad: $(wait_job "$JOB"): $(json GET "/stack/v1/jobs/$JOB" | field "['job']['reason']")"
[ -e "$DATA/engines/llama-server/b10797-bad/.engine-ready" ] && echo "READY MARKER PRESENT (wrong)" || echo "no ready marker for b10797-bad"

step "10. the current build cannot be removed; a staged one can"
curl -s -o /dev/null -w "delete current: HTTP %{http_code}\n" -X DELETE "$BASE/stack/v1/engines/llama-server/builds/$CURRENT_TAG"
curl -s -o /dev/null -w "delete staged proof tag: HTTP %{http_code}\n" -X DELETE "$BASE/stack/v1/engines/llama-server/builds/b10797-proof"

step "done"
