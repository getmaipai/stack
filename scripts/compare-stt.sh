#!/usr/bin/env bash
# Compare pinned Parakeet v2 and v3 on synthesized multilingual clips.
# Downloads and verifies both model archives and Silero VAD into scratch
# data, generates fixtures with macOS say/afconvert, then runs speech-worker
# directly so profile bindings are not changed. Streaming latency is out of scope.
#
#   bash scripts/compare-stt.sh            # port 8781
#   PORT=8791 KEEP_DATA=1 bash scripts/compare-stt.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8781}"
DATA="${DATA_DIR:-$PWD/data-scratch/compare-stt}"
OUT="$PWD/data-scratch/reports/stt-compare-$(date +%F).json"
FIXTURES="backend/src/speech/fixtures"
SENTENCES="$FIXTURES/compare-sentences.json"
V2_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2"
V2_SHA="6fc4426b54aa549a0019b8a75b8dea59164e71790a37ac56a045ad57f915f714"
V3_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2"
V3_SHA="1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9"
VAD_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
VAD_SHA="9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"
PIDS=()
WORKER_PID=""
cleanup() {
  if [ -n "$WORKER_PID" ]; then pkill -P "$WORKER_PID" 2>/dev/null || true; kill "$WORKER_PID" 2>/dev/null || true; wait "$WORKER_PID" 2>/dev/null || true; fi
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  if [ "${KEEP_DATA:-0}" != "1" ]; then rm -rf "$DATA"; echo "scratch data removed"; fi
}
trap cleanup EXIT
command -v say >/dev/null && command -v afconvert >/dev/null || { echo "compare-stt.sh requires macOS say and afconvert" >&2; exit 1; }
python3 - "$PORT" <<'PY'
import socket,sys
s=socket.socket()
try: s.bind(("127.0.0.1",int(sys.argv[1])))
except OSError: raise SystemExit(f"port {sys.argv[1]} is in use; choose another with PORT=")
finally: s.close()
PY
rm -rf "$DATA"
mkdir -p "$DATA/models" "$DATA/clips" "$(dirname "$OUT")"

fetch_verified() {
  local url="$1" sha="$2" path="$3" actual
  curl --fail --location --silent --show-error "$url" -o "$path"
  actual="$(shasum -a 256 "$path" | awk '{print $1}')"
  [ "$actual" = "$sha" ] || { echo "sha256 mismatch for $path: $actual" >&2; return 1; }
}

echo "== fetching and verifying model archives and Silero VAD"
fetch_verified "$V2_URL" "$V2_SHA" "$DATA/v2.tar.bz2"
fetch_verified "$V3_URL" "$V3_SHA" "$DATA/v3.tar.bz2"
fetch_verified "$VAD_URL" "$VAD_SHA" "$DATA/silero_vad.onnx"
mkdir -p "$DATA/models/v2" "$DATA/models/v3"
tar -xjf "$DATA/v2.tar.bz2" -C "$DATA/models/v2" --strip-components=1
tar -xjf "$DATA/v3.tar.bz2" -C "$DATA/models/v3" --strip-components=1

echo "== generating synthesized fixtures"
python3 - "$SENTENCES" "$DATA/clips" <<'PY'
import json,subprocess,sys
rows=json.load(open(sys.argv[1])); out=sys.argv[2]
available=subprocess.check_output(["say","-v","?"],text=True)
voices={"en":["Samantha","Ava","Alex"],"de":["Anna","Petra"],"es":["Paulina","Monica"]}
chosen={}
for lang,candidates in voices.items():
    chosen[lang]=next((v for v in candidates if any(line.split()[0]==v for line in available.splitlines())),None)
    if chosen[lang] is None: print(f"Skipping {lang}: no matching macOS say voice found")
for r in rows:
    voice=chosen[r["lang"]]
    if voice is None: continue
    stem=r["id"]
    subprocess.run(["say","-v",voice,"-o",f"{out}/{stem}.aiff",r["text"]],check=True)
    subprocess.run(["afconvert","-f","WAVE","-d","LEI16@16000","-c","1",f"{out}/{stem}.aiff",f"{out}/{stem}.wav"],check=True)
PY

echo "== benchmark"
MODEL_LABELS=(v2 v3)
for index in 0 1; do
  label="${MODEL_LABELS[$index]}"; model="$DATA/models/$label"; port=$((PORT + index))
  if [ "$index" -eq 0 ]; then [ -s "$DATA/v2.tar.bz2" ] || continue; fi
  if ! python3 - "$port" <<'PY'
import socket,sys
s=socket.socket()
try: s.bind(("127.0.0.1",int(sys.argv[1])))
except OSError: raise SystemExit(1)
finally: s.close()
PY
  then echo "port $port is in use; choose another base PORT=" >&2; exit 1; fi
  # The worker exits when its stdin closes, so hand it a pipe that stays open.
  rm -f "$DATA/stdin-$label"; mkfifo "$DATA/stdin-$label"; exec 9<>"$DATA/stdin-$label"
  start="$(python3 -c 'import time;print(time.time())')"
  (cd backend && bun run src/index.ts speech-worker --role stt --port "$port" --model "$model" --vad "$DATA/silero_vad.onnx" --threads 2) <&9 >"$DATA/$label-worker.log" 2>&1 &
  WORKER_PID=$!
  PIDS+=("$WORKER_PID")
  for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:$port/health" >/dev/null && break; sleep 0.25; done
  curl -sf "http://127.0.0.1:$port/health" >/dev/null || { cat "$DATA/$label-worker.log"; echo "$label worker did not start" >&2; exit 1; }
  load_seconds="$(python3 -c "import time;print(round(time.time()-$start,3))")"
  echo "$label worker loaded in ${load_seconds}s"
  printf '%s\n' "$load_seconds" >"$DATA/$label-load-seconds"
  first_clip="$(find "$DATA/clips" -name '*.wav' | sort | head -1)"
  [ -n "$first_clip" ] || { echo "no fixture clips were generated" >&2; exit 1; }
  curl -sf -X POST "http://127.0.0.1:$port/v1/audio/transcriptions" -F "file=@$first_clip;type=audio/wav" >/dev/null
  : >"$DATA/$label-results.ndjson"
  while IFS=$'\t' read -r id lang reference; do
    clip="$DATA/clips/$id.wav"; [ -f "$clip" ] || continue
    began="$(python3 -c 'import time;print(time.time())')"
    response="$(curl -sf -X POST "http://127.0.0.1:$port/v1/audio/transcriptions" -F "file=@$clip;type=audio/wav")"
    elapsed="$(python3 -c "import time;print(round(time.time()-$began,6))")"
    rss=0
    for pid in $(pgrep -P "$WORKER_PID" 2>/dev/null || true) "$WORKER_PID"; do
      value="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true)"; value="${value:-0}"
      [ "$value" -le "$rss" ] || rss="$value"
    done
    prev="$(cat "$DATA/$label-rss-peak" 2>/dev/null || echo 0)"; [ "$rss" -le "$prev" ] || echo "$rss" >"$DATA/$label-rss-peak"
    duration="$(afinfo "$clip" 2>/dev/null | awk '/estimated duration/ {print $3; exit}')"; duration="${duration:-0}"
    printf '%s\n' "$response" | bun -e 'import { wordErrorRate } from "./backend/src/speech/wer.ts"; let raw=""; for await (const chunk of Bun.stdin.stream()) raw += new TextDecoder().decode(chunk); const d=JSON.parse(raw); console.log(JSON.stringify({ transcript:d.text ?? "", wer:wordErrorRate(Bun.argv.at(-1)!,d.text ?? "") }));' -- "$reference" >"$DATA/$label-one.json"
    bun -e 'import { readFileSync, appendFileSync } from "node:fs"; const s=JSON.parse(readFileSync(process.argv[1],"utf8")); const row={id:process.argv[2],lang:process.argv[3],reference:process.argv[4],transcript:s.transcript,wer:s.wer,wallSeconds:Number(process.argv[5]),audioSeconds:Number(process.argv[6]),rtf:Number(process.argv[5])/Number(process.argv[6]),rssKb:Number(process.argv[7])}; appendFileSync(process.argv[8],JSON.stringify(row)+"\n");' "$DATA/$label-one.json" "$id" "$lang" "$reference" "$elapsed" "$duration" "$rss" "$DATA/$label-results.ndjson"
  done < <(python3 - "$SENTENCES" <<'PY'
import json,sys
for r in json.load(open(sys.argv[1])): print(r["id"],r["lang"],r["text"],sep="\t")
PY
  )
  exec 9>&-
  pkill -P "$WORKER_PID" 2>/dev/null || true; kill "$WORKER_PID" 2>/dev/null || true; wait "$WORKER_PID" 2>/dev/null || true; WORKER_PID=""
done
python3 - "$DATA" "$OUT" "$(cat "$DATA/v2-rss-peak" 2>/dev/null || echo 0)" "$(cat "$DATA/v3-rss-peak" 2>/dev/null || echo 0)" <<'PY'
import json,math,os,sys
root,out=sys.argv[1:3]; rss_peaks={"v2":int(sys.argv[3]),"v3":int(sys.argv[4])}; results={}
for model in ("v2","v3"):
    path=f"{root}/{model}-results.ndjson"
    rows=[json.loads(x) for x in open(path)] if os.path.exists(path) else []
    def mean(xs): return sum(xs)/len(xs) if xs else None
    def p95(xs): return sorted(xs)[max(0,math.ceil(.95*len(xs))-1)] if xs else None
    langs={lang:mean([r["wer"] for r in rows if r["lang"]==lang]) for lang in sorted({r["lang"] for r in rows})}
    load=f"{root}/{model}-load-seconds"
    results[model]={"loadSeconds":float(open(load).read()) if os.path.exists(load) else None,"clips":rows,"meanWer":mean([r["wer"] for r in rows]),"meanWerByLanguage":langs,"meanRtf":mean([r["rtf"] for r in rows]),"p95Rtf":p95([r["rtf"] for r in rows]),"peakRssKb":max(rss_peaks[model],max((r["rssKb"] for r in rows),default=0)) or None}
    log=f"{root}/{model}-worker.log"
    if os.path.exists(log):
        # The caller reports per-worker load time on stdout; it is recorded below from a sidecar if present.
        results[model]["workerLog"]=os.path.basename(log)
doc={"date":__import__("datetime").date.today().isoformat(),"fixture":os.path.basename("compare-sentences.json"),"streamingLatency":"out of scope","models":results}
open(out,"w").write(json.dumps(doc,ensure_ascii=False,indent=2)+"\n")
print("model  clips  mean WER  mean RTF  p95 RTF  peak RSS KB  WER by language")
for model,d in results.items(): print(f"{model:5}  {len(d['clips']):5}  {d['meanWer']!s:>8}  {d['meanRtf']!s:>8}  {d['p95Rtf']!s:>7}  {d['peakRssKb']!s:>11}  {d['meanWerByLanguage']}")
print(f"JSON: {out}")
PY
