#!/usr/bin/env bash
# STACK-94b: the stt role proven live through the public routes. Starts
# the daemon on loopback with a clean scratch data directory, installs
# the pinned Moonshine package and the Silero detector (real downloads,
# checksums verified), transcribes the bundled clip through
# POST /v1/audio/transcriptions with the identity headers, runs the
# readiness check, and drives the live session over the websocket with
# the same clip. Prints a transcript with timings; touches nothing
# outside the repo and the scratch directory.
#
#   bash scripts/prove-stt.sh            # port 8771
#   PORT=8790 bash scripts/prove-stt.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8771}"
BASE="http://127.0.0.1:$PORT"
DATA="${DATA_DIR:-$PWD/data-scratch}"
LOG="$DATA/daemon.log"
CLIP="backend/src/speech/fixtures/clover-two-seconds.wav"

port_free() { python3 -c "import socket,sys;s=socket.socket();s.settimeout(0.2)
try: s.bind(('127.0.0.1',int(sys.argv[1]))); s.close(); sys.exit(0)
except OSError: sys.exit(1)" "$1"; }
port_free "$PORT" || { echo "port $PORT is in use; pick another with PORT="; exit 1; }
rm -rf "$DATA"; mkdir -p "$DATA"

# The daemon leads its own process group, so the SIGKILL fallback takes a
# spawned worker with it instead of orphaning it on its port and memory.
STACK_DATA_DIR="$DATA" PORT="$PORT" python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' bun run backend/src/index.ts serve >"$LOG" 2>&1 &
PID=$!
echo "daemon pid $PID on port $PORT, data $DATA"
stop_daemon() {
  kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  kill -9 -- "-$PID" 2>/dev/null || true
}
cleanup() {
  stop_daemon
  if port_free "$PORT"; then echo "port $PORT free after stop"; else echo "port $PORT still held after stop"; fi
  if [ "${KEEP_DATA:-0}" != "1" ]; then rm -rf "$DATA"; echo "scratch data removed"; fi
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

step "1. the stt pins"
PINS="$(json GET /stack/v1/models/catalog | python3 -c "import json,sys;print(json.dumps([m for m in json.load(sys.stdin)['models'] if m['role']=='stt']))")"
echo "$PINS" | python3 -c "import json,sys;[print('pin', m['id'], m.get('component') or 'model', m['download']['sha256'][:12], m['download']['approx_bytes'], 'bytes') for m in json.load(sys.stdin)]"

step "2. install the packages (real downloads, checksums verified)"
for ID in silero-vad moonshine-tiny-en-int8; do
  BODY="$(echo "$PINS" | python3 -c "import json,sys;m=[m for m in json.load(sys.stdin) if m['id']==sys.argv[1]][0]
b={'id':m['id'],'role':m['role'],'url':m['download']['url'],'sha256':m['download']['sha256'],'approx_bytes':m['download']['approx_bytes'],'licence':m['license'],'revision':m['revision']}
b.update({k:m[k] for k in ('repo','engine','component') if m.get(k) is not None})
if m['download'].get('archive'): b['archive']=True
print(json.dumps(b))" "$ID")"
  T=$(now)
  JOB="$(json POST /stack/v1/models "$BODY" | field "['job']")"
  echo "$ID: job $JOB -> $(wait_job "$JOB") in $(since $T)"
done
json GET /stack/v1/models | python3 -c "import json,sys;[print('model', m['id'], m['state'], 'sha256', (m['sha256'] or '')[:12], 'verified', m['verifiedAt'] is not None, 'path', m['modelPath']) for m in json.load(sys.stdin)['models']]"
json GET /stack/v1/roles | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['roles'] if x['id']=='stt'][0];print('stt state before the first request:', r['state']['state'])"

step "3. the clip through POST /v1/audio/transcriptions (the worker's load plus the first transcript)"
T=$(now)
curl -s -i -X POST "$BASE/v1/audio/transcriptions" -F "file=@$CLIP;type=audio/wav" | tr -d '\r' | sed -n '1p;/^x-maipai/p;$p'
echo "in $(since $T)"
T=$(now)
curl -s -X POST "$BASE/v1/audio/transcriptions" -F "file=@$CLIP;type=audio/wav" -F "model=stt"; echo " (second request, loaded) in $(since $T)"
json GET /stack/v1/roles | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['roles'] if x['id']=='stt'][0];print('stt state', r['state']['state'], 'identity', r.get('identity'), 'measured footprint', r['model']['measuredFootprintBytes'])"

step "4. the readiness check"
T=$(now)
json POST /stack/v1/check | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok', d['ok'], [(r['role'], r['ok'], r.get('skipped', False)) for r in d['results']], 'fit', d['fitTogether'])"
echo "in $(since $T)"

step "5. the live session over WS /v1/audio/transcriptions/stream"
bun -e '
import { readFileSync } from "node:fs";
const bytes = readFileSync(process.argv[1]);
const view = new DataView(bytes.buffer, bytes.byteOffset);
let offset = 12, data = null;
while (offset + 8 <= bytes.length) { const id = String.fromCharCode(...bytes.subarray(offset, offset + 4)); const size = view.getUint32(offset + 4, true); if (id === "data") { data = bytes.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + (size % 2); }
const samples = new Float32Array(data.length / 2);
for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(data.byteOffset + i * 2, true) / 32768;
const t0 = performance.now();
const socket = new WebSocket(process.argv[2]);
let firstEventAt = null;
socket.onopen = () => {
  const silence = new Float32Array(16000 / 2);
  socket.send(silence.buffer);
  for (let i = 0; i < samples.length; i += 1024) socket.send(samples.slice(i, i + 1024).buffer);
  socket.send(new Float32Array(16000).buffer);
};
socket.onmessage = (m) => { const e = JSON.parse(m.data); console.log(`${(performance.now() - t0).toFixed(0).padStart(5)} ms`, JSON.stringify(e)); if (e.t === "final" || e.t === "no_speech" || e.t === "error") socket.close(); };
socket.onclose = () => process.exit(0);
setTimeout(() => { console.log("timed out"); process.exit(1); }, 15000);
' "$CLIP" "ws://127.0.0.1:$PORT/v1/audio/transcriptions/stream"

step "6. the worker is the Stack's own process"
json GET /stack/v1/roles | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['roles'] if x['id']=='stt'][0];print('stt', r['state']['state'], r.get('identity'))"
pgrep -f "speech-worker --role stt" | head -3 | while read -r wpid; do echo "worker pid $wpid: $(ps -o rss= -p "$wpid" | tr -d ' ') KB resident"; done

step "done"
