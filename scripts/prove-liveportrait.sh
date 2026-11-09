#!/usr/bin/env bash
# TALK-06: the talk-frames engine through the public route, for real. Starts
# the daemon on loopback with a clean scratch data directory, installs the six
# pinned LivePortrait weights (real downloads, sha256 verified, about 607 MB),
# asks for frames through POST /v1/images/talk-frames (the first request builds
# the pinned source, patches it, compiles the Apple face helper and builds the
# hashed Python environment: minutes, first time only), then asks again on the
# warm worker. Prints seconds per frame, the worker's peak memory (resident
# size and macOS footprint, sampled while it runs) and where the frames were
# saved. Touches nothing outside the repo, the scratch directory and OUT.
#
#   PICTURE=/path/to/portrait.png bash scripts/prove-liveportrait.sh
#   PICTURE=... LIP=0,0.3,0.7 EYE=0 OUT=/tmp/frames PORT=8772 DATA_DIR=/tmp/lp-data EXTRA_PICTURE=/path/cartoon.png bash scripts/prove-liveportrait.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PICTURE="${PICTURE:-${1:-}}"
[ -n "$PICTURE" ] && [ -f "$PICTURE" ] || { echo "usage: PICTURE=/path/to/portrait.png bash scripts/prove-liveportrait.sh"; exit 1; }
LIP="${LIP:-0,0.3,0.7}"
EYE="${EYE:-0}"
PORT="${PORT:-8772}"
BASE="http://127.0.0.1:$PORT"
DATA="${DATA_DIR:-$PWD/data-scratch/liveportrait}"
OUT="${OUT:-/tmp/maipai-talk-frames}"
LOG="$DATA/daemon.log"
mkdir -p "$OUT"

port_free() { python3 -c "import socket,sys;s=socket.socket();s.settimeout(0.2)
try: s.bind(('127.0.0.1',int(sys.argv[1]))); s.close(); sys.exit(0)
except OSError: sys.exit(1)" "$1"; }
port_free "$PORT" || { echo "port $PORT is in use; pick another with PORT="; exit 1; }
rm -rf "$DATA"; mkdir -p "$DATA"

STACK_DATA_DIR="$DATA" PORT="$PORT" python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' bun run backend/src/index.ts serve >"$LOG" 2>&1 &
PID=$!
echo "daemon pid $PID on port $PORT, data $DATA"
SAMPLER=""
stop_daemon() {
  [ -n "$SAMPLER" ] && kill "$SAMPLER" 2>/dev/null || true
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
token_file="$DATA/keys/home-view-token"; for _ in $(seq 1 40); do [ -s "$token_file" ] && break; sleep 0.25; done
[ -s "$token_file" ] || { echo "the Stack made no token file at $token_file"; exit 1; }
CURL_HOME="$(mktemp -d)"; chmod 700 "$CURL_HOME"; export CURL_HOME
printf 'header = "x-maipai-home-token: %s"\n' "$(tr -d '\n' < "$token_file")" > "$CURL_HOME/.curlrc"

now() { python3 -c 'import time;print(time.time())'; }
since() { python3 -c "import time;print(f'{time.time()-$1:.1f}s')"; }
json() { curl -s -X "$1" "$BASE$2" -H 'content-type: application/json' ${3:+-d "$3"}; }
field() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1"; }
step() { echo; echo "== $*"; }

# The worker's peak memory: resident size and macOS footprint (which counts GPU buffers), sampled while it lives.
PEAK="$DATA/peak.txt"; echo "0 0" > "$PEAK"
python3 - "$PEAK" <<'PY' &
import re, subprocess, sys, time
path = sys.argv[1]; best_rss = 0; best_fp = 0
UNITS = {"KB": 1e3, "MB": 1e6, "GB": 1e9}
while True:
    ps = subprocess.run(["ps", "-axo", "pid=,rss=,command="], capture_output=True, text=True).stdout.splitlines()
    for line in ps:
        parts = line.split(None, 2)
        if len(parts) == 3 and "liveportrait_worker.py" in parts[2] and " -I " in parts[2] and "python3 -c" not in parts[2]:
            best_rss = max(best_rss, int(parts[1]) * 1024)
            out = subprocess.run(["footprint", "-p", parts[0]], capture_output=True, text=True).stdout
            m = re.search(r"Footprint:\s+([\d.]+)\s*(KB|MB|GB)", out)
            if m: best_fp = max(best_fp, int(float(m.group(1)) * UNITS[m.group(2)]))
    open(path, "w").write(f"{best_rss} {best_fp}\n")
    time.sleep(0.25)
PY
SAMPLER=$!

step "1. the engine before anything is installed"
json GET /stack/v1/image-tools | python3 -c "import json,sys;t=json.load(sys.stdin)['talk_frames'];print(json.dumps({k:t[k] for k in ('state','installed','environmentReady','modelsVerified','helperCompiled','lastSuccessfulRun')}))"

step "2. install the six pinned weights (real downloads, sha256 verified)"
T=$(now)
json GET /stack/v1/models/catalog | python3 -c "import json,sys
for m in json.load(sys.stdin)['models']:
    if m.get('engine')=='liveportrait':
        b={'id':m['id'],'role':m['role'],'url':m['download']['url'],'sha256':m['download']['sha256'],'approx_bytes':m['download']['approx_bytes'],'licence':m['license'],'revision':m['revision']}
        b.update({k:m[k] for k in ('repo','engine') if m.get(k) is not None})
        print(json.dumps(b))" > "$DATA/pins.jsonl"
[ -s "$DATA/pins.jsonl" ] || { echo "the catalog lists no liveportrait weights"; exit 1; }
while IFS= read -r BODY; do
  JOB="$(json POST /stack/v1/models "$BODY" | field "['job']")"
  while :; do S="$(json GET "/stack/v1/jobs/$JOB" | python3 -c "import json,sys;j=json.load(sys.stdin)['job'];print(j['state'], j['percent'])")"; case "$S" in done*|failed*|cancelled*) break;; esac; sleep 3; done
  echo "  $(echo "$BODY" | field "['id']"): $S"
done < "$DATA/pins.jsonl"
json GET /stack/v1/models | python3 -c "import json,sys;[print('model', m['id'], m['state'], 'sha256', (m['sha256'] or '')[:12], 'bytes', m['sizeBytes']) for m in json.load(sys.stdin)['models'] if m['id'].startswith('liveportrait')]"
echo "weights in $(since $T)"

request() { # request <label> <timeout_ms>: POST, print status and body summary into $DATA/$1.json
  curl -s -o "$DATA/$1.json" -w "HTTP %{http_code} in %{time_total}s\n" -X POST "$BASE/v1/images/talk-frames" -F "image=@$PICTURE" -F "lip=$LIP" -F "eye=$EYE" -F "timeout_ms=$2"
}
poll() { # poll <job>: wait for a 202'd job
  local id="$1" last=""
  while :; do
    S="$(json GET "/stack/v1/jobs/$id" | python3 -c "import json,sys;j=json.load(sys.stdin)['job'];print(j['state'], '|', j['status'])")"
    [ "$S" != "$last" ] && { echo "  $S"; last="$S"; }
    case "$S" in done*|failed*|cancelled*) break;; esac; sleep 5
  done
}

step "3. first request: builds the source, the helper and the environment, then makes the frames (lip $LIP, eye $EYE)"
T=$(now)
request first 5000
if python3 -c "import json,sys;sys.exit(0 if json.load(open('$DATA/first.json')).get('frames') else 1)"; then :; else
  JOB="$(python3 -c "import json;print(json.load(open('$DATA/first.json')).get('job',''))")"
  [ -n "$JOB" ] && poll "$JOB" || { cat "$DATA/first.json"; echo; echo "(a refusal is a valid transcript: it is the engine's answer)"; }
fi
echo "first request finished in $(since $T)"
json GET /stack/v1/image-tools | python3 -c "import json,sys;t=json.load(sys.stdin)['talk_frames'];print(json.dumps({k:t[k] for k in ('state','installed','environmentReady','modelsVerified','helperCompiled','lastSuccessfulRun')}))"

step "4. second request on the warm worker (models already loaded)"
T=$(now)
request warm 300000
echo "warm request wall time $(since $T)"
python3 - "$DATA/warm.json" "$OUT" "$BASE" "$CURL_HOME" <<'PY'
import json, os, subprocess, sys
body = json.load(open(sys.argv[1])); out = sys.argv[2]; base = sys.argv[3]
if not body.get("frames"):
    print("no frames:", json.dumps(body)[:300]); sys.exit(0)
print("source ratios: eye", body["sourceEye"], "lip", body["sourceLip"])
total = 0
for i, f in enumerate(body["frames"]):
    path = os.path.join(out, f"{f['kind']}-{f['ratio']}.png")
    subprocess.run(["curl", "-s", "-o", path, base + f["url"]], check=True, env={**os.environ, "CURL_HOME": sys.argv[4]})
    head = open(path, "rb").read(8)
    assert head[:4] == b"\x89PNG", "not a PNG"
    total += f["ms"]
    print(f"  frame {i}: {f['kind']} {f['ratio']}  {f['ms'] / 1000:.2f} s  {f['width']}x{f['height']}  {os.path.getsize(path)} bytes  {path}")
print(f"seconds per frame (warm): {total / len(body['frames']) / 1000:.2f}")
PY

if [ -n "${EXTRA_PICTURE:-}" ] && [ -f "$EXTRA_PICTURE" ]; then
  step "4b. a second picture (EXTRA_PICTURE, for example a cartoon face): the engine's answer, whatever it is"
  curl -s -o "$DATA/extra.json" -w "HTTP %{http_code} in %{time_total}s\n" -X POST "$BASE/v1/images/talk-frames" -F "image=@$EXTRA_PICTURE" -F "lip=$LIP" -F "eye=$EYE" -F "timeout_ms=300000"
  python3 -c "import json;d=json.load(open('$DATA/extra.json'));print(json.dumps({k:d[k] for k in d if k!='frames'}), 'frames:', len(d.get('frames') or []))"
fi

step "5. the worker's peak memory while it ran"
sleep 1
read -r RSS FP < "$PEAK"
python3 -c "print('peak resident size: %.2f GB, peak footprint (counts GPU buffers): %.2f GB' % ($RSS/1e9, $FP/1e9))"

step "6. the governor's view and the engine row"
json GET /stack/v1/hardware/budget/decisions | python3 -c "import json,sys;d=json.load(sys.stdin);[print('decision', x['decision'], x['model'], x['reason']) for x in (d.get('decisions') or d) if 'liveportrait' in str(x.get('model'))][:3]" || true
json GET /stack/v1/image-tools | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['talk_frames']))"

step "done; frames in $OUT"
ls -la "$OUT"
