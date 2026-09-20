#!/usr/bin/env bash
# STACK-74: the Studio bench, one reproducible command. The protocol is
# docs/plans/studio-bench-protocol-2026-09-20.md; this script is its
# executable form. Starts the daemon on loopback with a clean scratch
# data directory, installs the pinned engine and the models named on the
# command line (the shipped pin by default), and for each model and
# context: runs llama-bench from the installed build with nothing loaded,
# then loads the model through the public route, times eight streamed
# route requests to their first token, samples the memory budget every
# 250 ms, runs the readiness check, and judges the row against the
# protocol's thresholds, including generated tokens/s against the
# previous run for the same model, context and build. Ends with the
# rollback rehearsal. Reports live under data-bench/<timestamp>/ (kept
# across runs, git-ignored); the daemon's scratch data is data-scratch/.
# Touches nothing outside the repo and those two directories.
#
#   bash scripts/bench/studio-bench.sh                   # the shipped pin, contexts 4096 and 16384
#   MODELS="qwen3-1.7b-q8-0 other-pin-id" CONTEXTS="4096" bash scripts/bench/studio-bench.sh
#   PORT=8790 REHEARSAL=0 bash scripts/bench/studio-bench.sh
#   DRY_RUN=1 bash scripts/bench/studio-bench.sh          # print the plan, run nothing
set -euo pipefail
cd "$(dirname "$0")/../.."
. "$(dirname "$0")/../lib/daemon.sh"

PORT="${PORT:-8771}"
BASE="$(daemon_base "$PORT")"
DATA="$PWD/data-scratch"
REPORTS="$PWD/data-bench"
CONTEXTS="${CONTEXTS:-4096 16384}"
MODELS="${MODELS:-qwen3-1.7b-q8-0}"
REHEARSAL="${REHEARSAL:-1}"
REQUESTS="${REQUESTS:-8}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$REPORTS/$STAMP"
PROMPT="Explain, in plain words a busy parent would understand, why a family might keep its own AI at home instead of using one in the cloud, and name three everyday things it could help with around the house, keeping each to one sentence."

hardware_line() {
  if [ "$(uname -s)" = "Darwin" ]; then
    printf '%s, %s GB unified memory' "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'Apple silicon')" "$(( $(sysctl -n hw.memsize) / 1073741824 ))"
  else
    printf '%s, %s GB' "$(uname -m)" "$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1048576 ))"
  fi
}

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "Studio bench plan (dry run, nothing started)"
  echo "  hardware: $(hardware_line)"
  echo "  port $PORT, scratch data $DATA, report $OUT"
  echo "  models: $MODELS"
  echo "  contexts: $CONTEXTS"
  echo "  per row: llama-bench -p 512 -n 128 -r 3 with nothing loaded; load through the route; $REQUESTS streamed route requests (max_tokens 64) timed to the first token; budget sampled every 250 ms; readiness check"
  echo "  thresholds: post-load ok; no critical pressure; readiness ok and fit-together ok; median first token under 1000 ms; generated tok/s within 10% of the previous run for the same model, context and build (a first run is the baseline)"
  echo "  rehearsal: $([ "$REHEARSAL" = "1" ] && echo 'scripts/prove-pin-rollback.sh after the rows, in its own scratch directory' || echo 'skipped (REHEARSAL=0)')"
  exit 0
fi

daemon_port_free "$PORT" || { echo "port $PORT is in use; pick another with PORT="; exit 1; }
rm -rf "$DATA"; mkdir -p "$DATA" "$OUT"
LOG="$OUT/daemon.log"

daemon_start "$PORT" "$DATA" "$LOG"
SAMPLER=""
cleanup() {
  if [ -n "$SAMPLER" ]; then kill "$SAMPLER" 2>/dev/null || true; wait "$SAMPLER" 2>/dev/null || true; fi
  daemon_stop
  rm -rf "$DATA"; echo "scratch data removed; report: $OUT/report.md"
}
trap cleanup EXIT

now() { python3 -c 'import time;print(time.time())'; }
ms_since() { python3 -c "import time;print(int((time.time()-$1)*1000))"; }
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

# The budget sampler: one line of JSON every 250 ms for the whole run.
SAMPLES="$OUT/budget-samples.jsonl"
( while :; do curl -s "$BASE/stack/v1/hardware/budget" | python3 -c 'import json,sys,time;d=json.load(sys.stdin);print(json.dumps({"t":time.time(),"free":d["freeMemoryBytes"],"pressure":d["pressure"],"loaded":len(d["loaded"])}))' >>"$SAMPLES" 2>/dev/null || true; sleep 0.25; done ) &
SAMPLER=$!
disown "$SAMPLER" 2>/dev/null || true

HARDWARE="$(hardware_line)"
TIER="$(json GET /stack/v1/hardware | field "['proposed']['id'] if d['proposed'] else 'none'")"
echo "hardware: $HARDWARE (tier $TIER)"

echo "== install the pinned engine"
JOB="$(json POST /stack/v1/engines/llama-server/install '{}' | field "['job']")"
[ "$(wait_job "$JOB")" = "done" ] || { echo "engine install failed: $(json GET "/stack/v1/jobs/$JOB" | field "['job']['reason']")"; exit 1; }
ENGINE_DIR="$(json GET /stack/v1/engines | python3 -c "import json,sys;print([e['directory'] for e in json.load(sys.stdin)['engines'] if e['matchesThisMachine']][0])")"

# The latest previous report, for the throughput comparison.
PREVIOUS="$(ls -d "$REPORTS"/*/report.json 2>/dev/null | grep -v "$STAMP" | sort | tail -1 || true)"

ROWS="$OUT/rows.jsonl"; : >"$ROWS"
for MODEL in $MODELS; do
  echo "== install model $MODEL"
  PIN="$(json GET /stack/v1/models/catalog | python3 -c "import json,sys;ms=[m for m in json.load(sys.stdin)['models'] if m['id']==sys.argv[1]];print(json.dumps(ms[0]) if ms else '')" "$MODEL")"
  [ -n "$PIN" ] || { echo "no pin named $MODEL in this build's catalog"; exit 1; }
  BODY="$(echo "$PIN" | python3 -c "import json,sys;m=json.load(sys.stdin);b={'id':m['id'],'role':m['role'],'url':m['download']['url'],'sha256':m['download']['sha256'],'approx_bytes':m['download']['approx_bytes'],'licence':m['license'],'revision':m['revision']}
b.update({k:m[k] for k in ('repo','engine') if m.get(k) is not None})
print(json.dumps(b))")"
  REPLY="$(json POST /stack/v1/models "$BODY")"
  JOB="$(echo "$REPLY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('job',''))")"
  [ -n "$JOB" ] || { echo "model install refused: $REPLY"; exit 1; }
  [ "$(wait_job "$JOB")" = "done" ] || { echo "model install failed: $(json GET "/stack/v1/jobs/$JOB" | field "['job']['reason']")"; exit 1; }
  RECORD="$(json GET /stack/v1/models | python3 -c "import json,sys;print(json.dumps([m for m in json.load(sys.stdin)['models'] if m['id']==sys.argv[1]][0]))" "$MODEL")"
  MODEL_PATH="$(echo "$RECORD" | field "['modelPath']")"

  for CONTEXT in $CONTEXTS; do
    echo "== $MODEL at context $CONTEXT"
    json PUT /stack/v1/settings "{\"stack.engines.llama_server.context_length\":$CONTEXT}" >/dev/null
    json POST /stack/v1/settings/apply >/dev/null
    # Unload (the next request reloads at the new context), never stop
    # (a stop stays stopped until Home says start).
    json POST "/stack/v1/models/$MODEL/actions" '{"action":"unload"}' >/dev/null
    sleep 1
    # llama-bench first, with nothing loaded in the daemon, so its own
    # copy of the model never lands inside the row's pressure window.
    BENCH="{}"
    if [ -x "$ENGINE_DIR/llama-bench" ]; then
      BENCH_OUT="$("$ENGINE_DIR/llama-bench" -m "$MODEL_PATH" -p 512 -n 128 -r 3 -o json 2>/dev/null || echo '[]')"
      BENCH="$(python3 -c "
import json,sys
rows=json.loads(sys.argv[1]) if sys.argv[1].strip().startswith('[') else []
out={}
for r in rows:
    key='prompt_tps' if r.get('n_prompt',0)>0 and r.get('n_gen',0)==0 else 'gen_tps'
    out[key]=round(float(r.get('avg_ts',0)),1)
print(json.dumps(out))" "$BENCH_OUT")"
    fi
    SAMPLE_START="$(now)"
    T="$(now)"
    FIRST_BODY="$OUT/first-$MODEL-$CONTEXT.json"
    FIRST="$(curl -s -o "$FIRST_BODY" -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with just the word OK.\"}],\"max_tokens\":8}")"
    LOAD_MS="$(ms_since "$T")"
    FIRST_REASON="$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('offline_reason') or d.get('error') or '')" "$FIRST_BODY" 2>/dev/null || true)"
    BUILD="$(curl -s -i -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"OK\"}],\"max_tokens\":1}" | tr -d '\r' | sed -n 's/^x-maipai-engine: //p')"
    # Streamed route requests, timed to the first SSE chunk that carries
    # content (a token), not to the first byte of the stream.
    TIMES="$(python3 - "$BASE" "$MODEL" "$PROMPT" "$REQUESTS" <<'PYEOF'
import json, sys, time, urllib.request
base, model, prompt, count = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
out = []
for _ in range(count):
    body = json.dumps({"model": model, "stream": True, "messages": [{"role": "user", "content": prompt}], "max_tokens": 64}).encode()
    request = urllib.request.Request(f"{base}/v1/chat/completions", data=body, headers={"content-type": "application/json"}, method="POST")
    started = time.time(); first = None; status = 0
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            status = response.status
            for raw in response:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:") or line == "data: [DONE]": continue
                try: chunk = json.loads(line[5:])
                except ValueError: continue
                content = (chunk.get("choices") or [{}])[0].get("delta", {}).get("content")
                if content and first is None: first = time.time()
    except urllib.error.HTTPError as error: status = error.code
    except Exception: status = 0
    total = time.time()
    out.append({"first_token_ms": int((first - started) * 1000) if first else None, "total_ms": int((total - started) * 1000), "status": status})
print(json.dumps(out))
PYEOF
)"
    # The role is read after the requests, when the post-load check has
    # certainly written this load's measured footprint.
    ROLE="$(json GET /stack/v1/roles | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['roles'] if x['id']=='chat'][0];print(json.dumps({'state':r['state']['state'],'footprint':r['model']['measuredFootprintBytes'] if r['model'] else None,'context':r['model']['measuredContextLength'] if r['model'] else None}))")"
    CHECK="$(json POST /stack/v1/check | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({'ok':d['ok'],'fit':d['fitTogether']['ok'],'reason':d['reason'] or d['fitTogether']['reason']}))")"
    PRESSURE="$(python3 -c "
import json,sys
start=float(sys.argv[2]); free=[]; worst='normal'; order={'normal':0,'warn':1,'critical':2}
for line in open(sys.argv[1]):
    try: s=json.loads(line)
    except: continue
    if s['t']<start: continue
    free.append(s['free']); worst=max(worst,s['pressure'],key=lambda p:order[p])
print(json.dumps({'min_free_bytes':min(free) if free else None,'worst_pressure':worst,'samples':len(free)}))" "$SAMPLES" "$SAMPLE_START")"
    python3 - "$MODEL" "$CONTEXT" "$RECORD" "$LOAD_MS" "$FIRST" "$ROLE" "$BUILD" "$TIMES" "$BENCH" "$CHECK" "$PRESSURE" "$ROWS" "$FIRST_REASON" "$PREVIOUS" <<'EOF'
import json, statistics, sys
model, context, record, load_ms, first, role, build, times, bench, check, pressure, rows, first_reason, previous = sys.argv[1:]
record=json.loads(record); role=json.loads(role); times=json.loads(times); bench=json.loads(bench); check=json.loads(check); pressure=json.loads(pressure)
ok_times=[t for t in times if t["status"]==200 and t["first_token_ms"] is not None]
median_first=int(statistics.median([t["first_token_ms"] for t in ok_times])) if ok_times else None
# The previous run's generated tokens/s for the same model, context and build.
previous_gen=None
if previous:
    try:
        for r in json.load(open(previous))["rows"]:
            if r["model"]==model and r["context"]==int(context) and r["build"]==build and r["llama_bench"].get("gen_tps"): previous_gen=r["llama_bench"]["gen_tps"]
    except Exception: previous_gen=None
reasons=[]
if first!="200": reasons.append(f"the first request answered HTTP {first}" + (f" ({first_reason})" if first_reason else ""))
if pressure["worst_pressure"]=="critical": reasons.append("kernel pressure reached critical")
if not (check["ok"] and check["fit"]): reasons.append(f"readiness: {check['reason'] or 'not ok'}")
if median_first is None or median_first>=1000: reasons.append(f"median first token {median_first} ms")
gen=bench.get("gen_tps")
if previous_gen and gen and gen < previous_gen*0.9: reasons.append(f"generated tokens/s fell to {gen} from {previous_gen} (more than 10 percent)")
row={"model":model,"repo":record["provenance"].get("repo") or record["source"],"revision":record["revision"],"sha256":record["sha256"],"size_bytes":record["sizeBytes"],"context":int(context),"build":build,"load_ms":int(load_ms),"first_request_status":first,"role_state":role["state"],"measured_footprint_bytes":role["footprint"],"measured_context":role["context"],"route_requests":times,"median_first_token_ms":median_first,"llama_bench":bench,"previous_gen_tps":previous_gen,"readiness":check,"pressure":pressure,"pass":not reasons,"reasons":reasons}
open(rows,"a").write(json.dumps(row)+"\n")
print(f"row: {model} @ {context}: {'PASS' if not reasons else 'FAIL: '+'; '.join(reasons)}; load {load_ms} ms; median first token {median_first} ms; bench {bench}; previous gen {previous_gen}; footprint {role['footprint']}; min free {pressure['min_free_bytes']}; worst {pressure['worst_pressure']}")
EOF
  done
done

kill "$SAMPLER" 2>/dev/null || true; wait "$SAMPLER" 2>/dev/null || true; SAMPLER=""

REHEARSAL_OUT="skipped"
if [ "$REHEARSAL" = "1" ]; then
  echo "== rollback rehearsal"
  # The rehearsal needs the port and the memory: the daemon and any
  # engine it spawned are gone before it starts.
  daemon_stop
  daemon_port_free "$PORT" || { echo "port $PORT still held after the daemon stopped; the rehearsal cannot start"; exit 1; }
  REHEARSAL_LOG="$OUT/rehearsal.log"
  # Its own scratch directory (it removes it), never this run's report.
  if DATA_DIR="$DATA/rehearsal" PORT="$PORT" bash scripts/prove-pin-rollback.sh >"$REHEARSAL_LOG" 2>&1; then REHEARSAL_OUT="passed"; else REHEARSAL_OUT="FAILED"; fi
  echo "rehearsal $REHEARSAL_OUT (transcript $REHEARSAL_LOG)"
fi

python3 - "$OUT" "$HARDWARE" "$TIER" "$STAMP" "$REHEARSAL_OUT" "$PREVIOUS" <<'EOF'
import json, sys
out, hardware, tier, stamp, rehearsal, previous = sys.argv[1:]
rows=[json.loads(l) for l in open(f"{out}/rows.jsonl") if l.strip()]
report={"at":stamp,"hardware":hardware,"tier":tier,"previous_report":previous or None,"rows":rows,"rehearsal":rehearsal}
json.dump(report, open(f"{out}/report.json","w"), indent=2)
md=[f"# Studio bench {stamp}","",f"Hardware: {hardware} (tier {tier}). Protocol: docs/plans/studio-bench-protocol-2026-09-20.md. Previous run for the throughput comparison: {previous or 'none (this run is the baseline)'}.","","| Model | Revision | Context | Build | Load | First token (median) | Prompt tok/s | Gen tok/s (previous) | Footprint | Min free | Worst pressure | Readiness | Result |","|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|"]
gb=lambda b: f"{b/2**30:.2f} GB" if b else "n/a"
for r in rows:
    md.append(f"| `{r['model']}` | {r['revision'][:8]} | {r['context']} | {r['build']} | {r['load_ms']} ms | {r['median_first_token_ms']} ms | {r['llama_bench'].get('prompt_tps','n/a')} | {r['llama_bench'].get('gen_tps','n/a')} ({r['previous_gen_tps'] or 'baseline'}) | {gb(r['measured_footprint_bytes'])} | {gb(r['pressure']['min_free_bytes'])} | {r['pressure']['worst_pressure']} | {'ok' if r['readiness']['ok'] and r['readiness']['fit'] else r['readiness']['reason']} | {'pass' if r['pass'] else 'fail: '+'; '.join(r['reasons'])} |")
md += ["", f"Rollback rehearsal: {rehearsal} (rehearsal.log beside this report).", ""]
open(f"{out}/report.md","w").write("\n".join(md))
print("\n".join(md))
EOF
