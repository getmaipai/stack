#!/usr/bin/env bash
# STACK-13b: the image role through the public routes. Starts the daemon
# on loopback with a clean scratch data directory, installs the pinned
# ComfyUI source and builds its environment (real downloads, hashes
# verified), installs the pinned checkpoint (a 4.3 GB real download,
# sha256 verified), then asks for one render through
# POST /v1/images/generations: the governor admits the engine or refuses
# it with its numbers, and either outcome is the transcript. Prints
# timings; touches nothing outside the repo and the scratch directory.
#
#   bash scripts/prove-image.sh            # port 8771
#   PORT=8790 bash scripts/prove-image.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8771}"
BASE="http://127.0.0.1:$PORT"
DATA="${DATA_DIR:-$PWD/data-scratch}"
LOG="$DATA/daemon.log"
PROMPT="a small lighthouse on a rocky shore at dusk, painterly"

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
  for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
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
    sleep 1
  done
}
step() { echo; echo "== $*"; }

step "1. the machine and the governor before anything loads"
json GET /stack/v1/hardware/budget | python3 -c "import json,sys;d=json.load(sys.stdin);g=d.get('governor',d);print(json.dumps({k:g.get(k) for k in ('totalMemoryBytes','capBytes','freeMemoryBytes','availablePercent','pressure','memoryReadingDegraded')}))"

step "2. install ComfyUI: the source archive, uv, a managed Python, the hashed requirements"
T=$(now)
JOB="$(json POST /stack/v1/engines/comfyui/install '{}' | field "['job']")"
while :; do S="$(json GET "/stack/v1/jobs/$JOB" | python3 -c "import json,sys;j=json.load(sys.stdin)['job'];print(j['state'], j['status'], j['percent'])")"; echo "  $S ($(since $T))"; case "$S" in done*|failed*|cancelled*) break;; esac; sleep 5; done
json GET "/stack/v1/jobs/$JOB" | python3 -c "import json,sys;j=json.load(sys.stdin)['job'];print('job', j['state'], j.get('reason') or '')"
echo "installed in $(since $T)"
du -sh "$DATA/engines/comfyui" 2>/dev/null | sed 's|'"$DATA"'/||'

step "3. install the pinned checkpoint (4.3 GB, real download, sha256 verified)"
PIN="$(json GET /stack/v1/models/catalog | python3 -c "import json,sys;print(json.dumps([m for m in json.load(sys.stdin)['models'] if m['role']=='image'][0]))")"
BODY="$(echo "$PIN" | python3 -c "import json,sys;m=json.load(sys.stdin)
b={'id':m['id'],'role':m['role'],'url':m['download']['url'],'sha256':m['download']['sha256'],'approx_bytes':m['download']['approx_bytes'],'licence':m['license'],'revision':m['revision']}
b.update({k:m[k] for k in ('repo','engine') if m.get(k) is not None})
print(json.dumps(b))")"
T=$(now)
JOB="$(json POST /stack/v1/models "$BODY" | field "['job']")"
while :; do S="$(json GET "/stack/v1/jobs/$JOB" | python3 -c "import json,sys;j=json.load(sys.stdin)['job'];print(j['state'], j['status'], str(j['percent'])+'%')")"; echo "  $S ($(since $T))"; case "$S" in done*|failed*|cancelled*) break;; esac; sleep 15; done
json GET /stack/v1/models | python3 -c "import json,sys;[print('model', m['id'], m['state'], 'sha256', (m['sha256'] or '')[:12], 'bytes', m['sizeBytes']) for m in json.load(sys.stdin)['models']]"
json GET /stack/v1/roles | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['roles'] if x['id']=='image'][0];print('image state before the render:', r['state']['state'])"

step "4. the governor at the moment of the ask"
json GET /stack/v1/hardware/budget | python3 -c "import json,sys;d=json.load(sys.stdin);g=d.get('governor',d);print(json.dumps({k:g.get(k) for k in ('capBytes','freeMemoryBytes','availablePercent','pressure')}))"

step "5. one render through POST /v1/images/generations (the engine's start, the checkpoint's load, 8 steps at 512x512)"
T=$(now)
curl -s -D "$DATA/headers.txt" -o "$DATA/render.json" -w "HTTP %{http_code} in %{time_total}s\n" -X POST "$BASE/v1/images/generations" -H 'content-type: application/json' -d "{\"model\":\"image\",\"prompt\":\"$PROMPT\",\"size\":\"512x512\",\"steps\":8,\"seed\":7,\"timeout_ms\":600000}"
grep -i "^x-maipai" "$DATA/headers.txt" | tr -d '\r'
python3 - "$DATA/render.json" "$DATA" <<'EOF2'
import json, sys, base64
d = json.load(open(sys.argv[1]))
if d.get("data"):
    png = base64.b64decode(d["data"][0]["b64_json"]); open(sys.argv[2] + "/render.png", "wb").write(png)
    print("image", len(png), "bytes", png[1:4], "seed", d["data"][0].get("seed"), "job", d["job"])
else:
    print("no image:", json.dumps(d)[:400])
EOF2
echo "in $(since $T)"
json GET /stack/v1/roles | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['roles'] if x['id']=='image'][0];print('image state', r['state']['state'], 'reason', r['state'].get('reason'), 'identity', r.get('identity'), 'measured footprint', r['model']['measuredFootprintBytes'])"
json GET /stack/v1/hardware/budget/decisions | python3 -c "import json,sys;d=json.load(sys.stdin);[print('decision', x['at'][11:19], x['decision'], x['model'], x['reason']) for x in (d.get('decisions') or d)[:6]]"
json GET /stack/v1/jobs | python3 -c "import json,sys;[print('job', j['kind'], j['state'], j['status'], j.get('reason') or '') for j in json.load(sys.stdin)['jobs'][:3]]"

step "6. the readiness check"
json POST /stack/v1/check | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok', d['ok'], [(r['role'], r['ok'], r.get('skipped', False), r.get('reason')) for r in d['results']], 'fit', d['fitTogether'])"

step "7. the engine process, if it ran"
pgrep -f "main.py --listen 127.0.0.1" | head -1 | while read -r wpid; do echo "comfyui pid $wpid: $(ps -o rss= -p "$wpid" | tr -d ' ') KB resident"; done
[ -f "$DATA/render.png" ] && cp "$DATA/render.png" "${RENDER_OUT:-/tmp/maipai-stack-render.png}" && echo "render copied to ${RENDER_OUT:-/tmp/maipai-stack-render.png}"

step "done"
