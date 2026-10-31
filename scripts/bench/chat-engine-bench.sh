#!/usr/bin/env bash
# TIER-CHAT-BENCH-01: start a private llama-server and a private Splash on the same 27B model, on their own ports and only against the
# installed engines and model files (read only), run backend/scripts/chat-engine-bench.ts against both, then stop only the two pids it started.
# Never touches the live hub's engines. Run it when `uptime` load is under 25, one heavy run at a time.
#
#   bash scripts/bench/chat-engine-bench.sh            # idle and beside-a-second-request rows
#   BALLAST_GB=40 bash scripts/bench/chat-engine-bench.sh   # adds the held-lease rows
#   DRY_RUN=1 bash scripts/bench/chat-engine-bench.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DATA="${MAIPAI_STACK_DATA:-/usr/local/maipai-home/stack/data}"
LLAMA_PORT="${LLAMA_PORT:-8791}"; SPLASH_PORT="${SPLASH_PORT:-8792}"
MODEL_NAME="qwen3-8-27b-huihui-abliterated-iq4-xs"
GGUF="$DATA/models/$MODEL_NAME/Huihui-Qwen3.8-27B-abliterated-UD-IQ4_XS.gguf"
LLAMA="$(ls -d "$DATA"/engines/llama-server/*/llama-server | tail -1)"
SPL="$DATA/engines/splash-chat/$(ls "$DATA/engines/splash-chat" | grep -v current | tail -1)"
SEL="$(grep -l "Huihui-Qwen3.8-27B-abliterated-UD-IQ4_XS" "$DATA"/splash/home/Library/Application\ Support/Splash/models/.selections/*/model.json 2>/dev/null | head -1 | xargs -I{} dirname {} || true)"
[ -n "$SEL" ] || { echo "no Splash selection for the Huihui 27B under $DATA/splash"; exit 1; }
CTX="${CTX:-32768}"
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "llama-server: $LLAMA -m $GGUF --port $LLAMA_PORT -c $CTX"
  echo "splash: $SPL/python/bin/python3 -m server.server $SEL --port $SPLASH_PORT --max-context=$CTX"
  (cd backend && DRY_RUN=1 TARGETS="llama=http://127.0.0.1:$LLAMA_PORT|$MODEL_NAME|0,splash=http://127.0.0.1:$SPLASH_PORT|$MODEL_NAME|0" bun run bench:chat-engines)
  exit 0
fi
for p in "$LLAMA_PORT" "$SPLASH_PORT"; do lsof -i ":$p" >/dev/null 2>&1 && { echo "port $p is in use; pick another"; exit 1; }; done
FREE_GB="$(vm_stat | awk '/page size/ {ps=$8} /Pages free|Pages inactive|Pages speculative/ {n+=$NF} END {printf "%d", n*ps/1073741824}')"
[ "$FREE_GB" -ge "${MIN_FREE_GB:-45}" ] || { echo "only about $FREE_GB GB is free; two 27B copies need ${MIN_FREE_GB:-45} GB beside the live hub. Try again later or set MIN_FREE_GB."; exit 1; }
LP=""; SP=""
cleanup() { for p in $SP $LP; do [ -n "$p" ] || continue; pkill -P "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT
"$LLAMA" --model "$GGUF" --port "$LLAMA_PORT" --host 127.0.0.1 -c "$CTX" -fa on -ngl 99 --jinja >"${TMPDIR:-/tmp}/bench-llama.log" 2>&1 & LP=$!
(cd "$SPL" && HOME="$DATA/splash/home" HF_HOME="$DATA/splash/home" HF_HUB_CACHE="$DATA/splash/hub" HF_HUB_OFFLINE=1 \
  exec "$SPL/python/bin/python3" -u -P -m server.server "$SEL" --model huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:UD-IQ4_XS \
  --binary "$SPL/engine/splash" --port "$SPLASH_PORT" --no-webui --max-context="$CTX" --idle-release=off \
  --served-model-name="$MODEL_NAME" --announce-served-name --default-reasoning-effort=medium >"${TMPDIR:-/tmp}/bench-splash.log" 2>&1) & SP=$!
for port in "$LLAMA_PORT" "$SPLASH_PORT"; do
  for _ in $(seq 1 180); do curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break; sleep 2; done
  curl -sf "http://127.0.0.1:$port/health" >/dev/null || { echo "engine on $port did not become healthy; see ${TMPDIR:-/tmp}/bench-*.log"; exit 1; }
done
cd backend
TARGETS="llama=http://127.0.0.1:$LLAMA_PORT|$MODEL_NAME|$LP,splash=http://127.0.0.1:$SPLASH_PORT|$MODEL_NAME|$SP" bun run bench:chat-engines
