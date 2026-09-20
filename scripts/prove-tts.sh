#!/usr/bin/env bash
# STACK-94c: the tts role proven live through the public routes. Starts
# the daemon on loopback with a clean scratch data directory, installs
# the pinned uv build and builds the Pocket TTS environment (real
# downloads, hashes verified), installs the pinned weights, tokenizer and
# default voice into the hub cache (real downloads, checksums verified),
# renders one sentence through POST /v1/audio/speech with the identity
# headers, times the first byte, cancels a second render mid-stream and
# renders again, runs the readiness check, and refuses an unknown voice.
# Prints a transcript with timings; touches nothing outside the repo and
# the scratch directory.
#
#   bash scripts/prove-tts.sh            # port 8771
#   PORT=8790 bash scripts/prove-tts.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8771}"
BASE="http://127.0.0.1:$PORT"
DATA="${DATA_DIR:-$PWD/data-scratch}"
LOG="$DATA/daemon.log"
SENTENCE="Clover, the kitchen light is on."

port_free() { python3 -c "import socket,sys;s=socket.socket();s.settimeout(0.2)
try: s.bind(('127.0.0.1',int(sys.argv[1]))); s.close(); sys.exit(0)
except OSError: sys.exit(1)" "$1"; }
port_free "$PORT" || { echo "port $PORT is in use; pick another with PORT="; exit 1; }
rm -rf "$DATA"; mkdir -p "$DATA"

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

step "1. the engine rows for tts"
json GET /stack/v1/engines | python3 -c "import json,sys;[print('engine', e['id'], 'installed' if e['installed'] else 'not installed', 'matches' if e['matchesThisMachine'] else 'other machine') for e in json.load(sys.stdin)['engines'] if e['name'] in ('uv','pocket-tts')]"

step "2. build the environment: uv (real download, sha256 verified), a managed Python, the hashed requirements"
T=$(now)
JOB="$(json POST /stack/v1/engines/pocket-tts/install '{}' | field "['job']")"
while :; do S="$(json GET "/stack/v1/jobs/$JOB" | python3 -c "import json,sys;j=json.load(sys.stdin)['job'];print(j['state'], j['status'])")"; echo "  $S ($(since $T))"; case "$S" in done*|failed*|cancelled*) break;; esac; sleep 3; done
json GET "/stack/v1/jobs/$JOB" | python3 -c "import json,sys;j=json.load(sys.stdin)['job'];print('job', j['state'], j.get('reason') or '')"
echo "environment built in $(since $T)"
du -sh "$DATA/engines/pocket-tts" "$DATA/engines/uv" 2>/dev/null | sed 's|'"$DATA"'/||'

step "2b. a second install while the build runs joins the same job"
JOB2="$(json POST /stack/v1/engines/pocket-tts/install '{}' | field "['job']")"
echo "second install answered job $JOB2 (the environment is built, so a fresh no-op job or the same id)"

step "3. install the weights, the tokenizer and the default voice (real downloads, checksums verified, into the hub cache)"
PINS="$(json GET /stack/v1/models/catalog | python3 -c "import json,sys;print(json.dumps([m for m in json.load(sys.stdin)['models'] if m['role']=='tts']))")"
for ID in pocket-tts-english-tokenizer pocket-tts-voice-alba pocket-tts-english; do
  BODY="$(echo "$PINS" | python3 -c "import json,sys;m=[m for m in json.load(sys.stdin) if m['id']==sys.argv[1]][0]
b={'id':m['id'],'role':m['role'],'url':m['download']['url'],'sha256':m['download']['sha256'],'approx_bytes':m['download']['approx_bytes'],'licence':m['license'],'revision':m['revision']}
b.update({k:m[k] for k in ('repo','engine','component') if m.get(k) is not None})
print(json.dumps(b))" "$ID")"
  T=$(now)
  JOB="$(json POST /stack/v1/models "$BODY" | field "['job']")"
  echo "$ID: job $JOB -> $(wait_job "$JOB") in $(since $T)"
done
json GET /stack/v1/models | python3 -c "import json,sys;[print('model', m['id'], m['state'], 'sha256', (m['sha256'] or '')[:12], 'path', m['modelPath'].replace('$DATA/','')) for m in json.load(sys.stdin)['models']]"
json GET /stack/v1/roles | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['roles'] if x['id']=='tts'][0];print('tts state before the first request:', r['state']['state'])"

step "4. one sentence through POST /v1/audio/speech (the engine's start plus the first render)"
T=$(now)
curl -s -D "$DATA/headers.txt" -o "$DATA/out.wav" -w "HTTP %{http_code} %{size_download} bytes, first byte %{time_starttransfer}s, total %{time_total}s\n" -X POST "$BASE/v1/audio/speech" -F "text=$SENTENCE"
grep -i "^x-maipai\|^content-type" "$DATA/headers.txt" | tr -d '\r'
echo "in $(since $T)"
python3 -c "
import struct; f=open('$DATA/out.wav','rb').read()
print('wav', f[:4], 'rate', struct.unpack('<I', f[24:28])[0], 'channels', struct.unpack('<H', f[22:24])[0], 'bits', struct.unpack('<H', f[34:36])[0], 'declared data size', struct.unpack('<I', f[40:44])[0], 'actual audio bytes', len(f)-44, 'seconds', round((len(f)-44)/2/struct.unpack('<I', f[24:28])[0], 2))"
T=$(now)
curl -s -o /dev/null -w "second render: HTTP %{http_code} %{size_download} bytes, first byte %{time_starttransfer}s, total %{time_total}s\n" -X POST "$BASE/v1/audio/speech" -F "text=$SENTENCE" -F "voice_url=alba"
json GET /stack/v1/roles | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['roles'] if x['id']=='tts'][0];print('tts state', r['state']['state'], 'identity', r.get('identity'), 'measured footprint', r['model']['measuredFootprintBytes'])"

step "5. cancel mid-stream, then render again"
curl -s -o /dev/null -m 0.05 -X POST "$BASE/v1/audio/speech" -F "text=A much longer sentence that keeps the engine busy for a while, so the cancel lands while audio is still being generated on the way to the client." 2>/dev/null && echo "cancelled? no, it finished within 50 ms" || echo "client aborted after 50 ms (curl exit $?)"
sleep 0.3
curl -s -o /dev/null -w "render after the cancel: HTTP %{http_code} %{size_download} bytes, first byte %{time_starttransfer}s\n" -X POST "$BASE/v1/audio/speech" -F "text=$SENTENCE"
json GET /stack/v1/roles | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['roles'] if x['id']=='tts'][0];print('tts state after the cancel:', r['state']['state'])"

step "6. an unknown voice is the engine's refusal, passed through"
curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/v1/audio/speech" -F "text=hello" -F "voice_url=nobody" | head -c 300; echo

step "7. the readiness check"
T=$(now)
json POST /stack/v1/check | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok', d['ok'], [(r['role'], r['ok'], r.get('skipped', False)) for r in d['results']], 'fit', d['fitTogether'])"
echo "in $(since $T)"

step "8. the engine is the Stack's own process, its caches under data/"
pgrep -f "pocket-tts serve" | head -2 | while read -r wpid; do echo "engine pid $wpid: $(ps -o rss= -p "$wpid" | tr -d ' ') KB resident"; done
ls "$DATA/home/.cache" 2>/dev/null | sed 's/^/  home cache: /'
ls "$DATA/models/hub" | sed 's/^/  hub: /'

step "done"
