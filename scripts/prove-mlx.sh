#!/usr/bin/env bash
# STACK-93: the chat role on the second Mac engine, mlx-serve, through
# the public routes. Starts the daemon on loopback with a clean scratch
# data directory, installs the pinned mlx-serve build (a 72 MB real
# download, sha256 verified) and the pinned MLX model (nine files, 984
# MB, each sha256 verified), switches the chat engine by setting
# (stored, then applied as Home's restart would), asks one chat
# completion through POST /v1/chat/completions and reads the identity
# headers the Stack stamps, then a second one on the same process, then
# the readiness check. The governor admits the engine at its estimated
# peak or refuses it with its numbers; either outcome is the
# transcript. Touches nothing outside the repo and the scratch
# directory.
#
#   bash scripts/prove-mlx.sh            # port 8771
#   PORT=8790 bash scripts/prove-mlx.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8771}"
BASE="http://127.0.0.1:$PORT"
DATA="${DATA_DIR:-$PWD/data-scratch}"
LOG="$DATA/daemon.log"

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
follow_job() {
  local id="$1" started="$2" every="$3" S
  while :; do S="$(json GET "/stack/v1/jobs/$id" | python3 -c "import json,sys;j=json.load(sys.stdin)['job'];print(j['state'], j['status'], str(j['percent'])+'%')")"; echo "  $S ($(since "$started"))"; case "$S" in done*|failed*|cancelled*) break;; esac; sleep "$every"; done
  json GET "/stack/v1/jobs/$id" | python3 -c "import json,sys;j=json.load(sys.stdin)['job'];print('job', j['state'], j.get('reason') or '')"
}
chat() {
  local label="$1" content="$2" T
  T=$(now)
  curl -s -D "$DATA/headers.txt" -o "$DATA/chat.json" -w "HTTP %{http_code} in %{time_total}s\n" -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' -d "{\"model\":\"chat\",\"messages\":[{\"role\":\"user\",\"content\":\"$content\"}],\"max_tokens\":24,\"temperature\":0}"
  grep -i "^x-maipai" "$DATA/headers.txt" | tr -d '\r'
  python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print('$label reply:', repr((d.get('choices') or [{}])[0].get('message',{}).get('content')) if d.get('choices') else json.dumps(d)[:300])" "$DATA/chat.json"
  echo "in $(since $T)"
}
step() { echo; echo "== $*"; }

step "1. the machine and the governor before anything loads"
json GET /stack/v1/hardware/budget | python3 -c "import json,sys;d=json.load(sys.stdin);g=d.get('governor',d);print(json.dumps({k:g.get(k) for k in ('totalMemoryBytes','capBytes','freeMemoryBytes','availablePercent','pressure','memoryReadingDegraded')}))"
json GET /stack/v1/engines | python3 -c "import json,sys;[print('engine', e['id'], 'installed', e['installed'], 'matches', e['matchesThisMachine']) for e in json.load(sys.stdin)['engines'] if e['name'] in ('llama-server','mlx-serve') and e['matchesThisMachine']]"

step "2. install mlx-serve (the pinned release, sha256 verified)"
T=$(now)
JOB="$(json POST /stack/v1/engines/mlx-serve/install '{}' | field "['job']")"
follow_job "$JOB" "$T" 2
echo "installed in $(since $T)"
du -sh "$DATA/engines/mlx-serve" 2>/dev/null | sed 's|'"$DATA"'/||'

step "3. install the pinned MLX model (nine files, 984 MB, each sha256 verified)"
PIN="$(json GET /stack/v1/models/catalog | python3 -c "import json,sys;print(json.dumps([m for m in json.load(sys.stdin)['models'] if m.get('engine')=='mlx-serve'][0]))")"
BODY="$(echo "$PIN" | python3 -c "import json,sys;m=json.load(sys.stdin)
b={'id':m['id'],'role':m['role'],'url':m['download']['url'],'sha256':m['download']['sha256'],'approx_bytes':m['download']['approx_bytes'],'licence':m['license'],'revision':m['revision']}
b.update({k:m[k] for k in ('repo','engine') if m.get(k) is not None})
print(json.dumps(b))")"
T=$(now)
JOB="$(json POST /stack/v1/models "$BODY" | field "['job']")"
follow_job "$JOB" "$T" 5
json GET /stack/v1/models | python3 -c "import json,sys;[print('model', m['id'], m['state'], 'provenance', m['provenance'], 'path', m['modelPath'].split('/')[-1], 'bytes', m['sizeBytes']) for m in json.load(sys.stdin)['models']]"
ls "$DATA"/models/*/Qwen3-1.7B-4bit | tr '\n' ' '; echo

step "4. the chat role before the switch: bound to llama-server, which is not installed here"
json GET /stack/v1/roles | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['roles'] if x['id']=='chat'][0];print('chat state', r['state']['state'], 'reason', r['state'].get('reason'))"

step "5. switch the chat engine by setting (stored as pending, then applied, as Home's restart would)"
json PUT /stack/v1/settings '{"stack.engines.chat.engine":"mlx-serve"}' | python3 -c "import json,sys;s=[x for x in json.load(sys.stdin)['settings'] if x['key']=='stack.engines.chat.engine'][0];print('in effect', s['in_effect'], 'pending', s['pending'], 'needs restart', s['needs_restart'])"
json POST /stack/v1/settings/apply | python3 -c "import json,sys;s=[x for x in json.load(sys.stdin)['settings'] if x['key']=='stack.engines.chat.engine'][0];print('in effect', s['in_effect'], 'pending', s['pending'])"
json GET /stack/v1/roles | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['roles'] if x['id']=='chat'][0];print('chat state', r['state']['state'], 'model', (r.get('model') or {}).get('id'))"

step "6. the governor at the moment of the ask"
json GET /stack/v1/hardware/budget | python3 -c "import json,sys;d=json.load(sys.stdin);g=d.get('governor',d);print(json.dumps({k:g.get(k) for k in ('capBytes','freeMemoryBytes','availablePercent','pressure')}))"

step "7. one chat completion (the engine's start, the model's load, the identity read after load)"
chat "first" "Reply with the single word OK."
json GET /stack/v1/roles | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['roles'] if x['id']=='chat'][0];print('chat state', r['state']['state'], 'reason', r['state'].get('reason'), 'identity', r.get('identity'), 'post-load', r['state'].get('postLoadCheck'), 'measured footprint', r['model']['measuredFootprintBytes'])"
json GET /stack/v1/hardware/budget/decisions | python3 -c "import json,sys;d=json.load(sys.stdin);[print('decision', x['at'][11:19], x['decision'], x['model'], x['reason']) for x in (d.get('decisions') or d)[:6]]"

step "8. a second completion on the warm process"
chat "second" "What is 2 plus 2? Answer with the number only."

step "9. the readiness check, then a restart through the engine route"
json POST /stack/v1/check | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok', d['ok'], [(r['role'], r['ok'], r.get('skipped', False), r.get('reason')) for r in d['results'] if r['role'] in ('chat','coding','judge','router')], 'fit', d['fitTogether'])"
T=$(now)
json POST /stack/v1/engines/mlx-serve/restart '{}' | python3 -c "import json,sys;print('restart', json.dumps(json.load(sys.stdin))[:200])"
echo "restarted and ready again in $(since $T)"
chat "after restart" "Reply with the single word OK."

step "10. the engine process"
pgrep -f "mlx-serve --model" | head -1 | while read -r wpid; do echo "mlx-serve pid $wpid: $(ps -o rss= -p "$wpid" | tr -d ' ') KB resident"; done

step "done"
