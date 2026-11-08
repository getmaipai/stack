# scripts/lib/daemon.sh — the one daemon start-and-stop library the prove
# and bench scripts source. Sourced, not executed:
#   . "$(dirname "$0")/lib/daemon.sh"    # from scripts/
#   . "$(dirname "$0")/../lib/daemon.sh" # from scripts/bench/
# The caller must have set PORT and BASE before calling daemon_start, and
# prepared the data directory and log. daemon_start sets DAEMON_PID. The
# caller owns its scratch directory: daemon_stop never removes it.

daemon_port_free() { python3 -c 'import socket,sys;s=socket.socket();s.settimeout(0.2)
try: s.bind(("127.0.0.1",int(sys.argv[1]))); s.close(); sys.exit(0)
except OSError: sys.exit(1)' "$1"; }

daemon_base() { echo "http://127.0.0.1:$1"; }

# Launches the daemon in its own session, sets DAEMON_PID, prints the pid
# line, and waits on /healthz up to 10 s, failing loudly with the log's
# tail. Its own scratch directory is the caller's, not this library's.
daemon_start() {
  STACK_DATA_DIR="$2" PORT="$1" python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' bun run backend/src/index.ts serve >"$3" 2>&1 &
  DAEMON_PID=$!
  echo "daemon pid $DAEMON_PID on port $1, data $2"
  for _ in $(seq 1 40); do curl -sf "$BASE/healthz" >/dev/null 2>&1 && break; sleep 0.25; done
  curl -sf "$BASE/healthz" >/dev/null || { echo "daemon did not answer"; tail -20 "$3"; exit 1; }
  use_stack_token "$2" || exit 1
}

# ISOLATION-04: every write to the Stack needs Home's token. After the daemon is up, point curl at a private config that adds it, so each
# curl call in the calling script carries the header with no change (CURL_HOME/.curlrc). $1 is the Stack's data directory.
use_stack_token() {
  local token_file="$1/keys/home-view-token" i
  for i in $(seq 1 40); do [ -s "$token_file" ] && break; sleep 0.25; done
  [ -s "$token_file" ] || { echo "the Stack made no token file at $token_file; its log says why"; return 1; }
  STACK_CURL_HOME="$(mktemp -d)"; chmod 700 "$STACK_CURL_HOME"
  printf 'header = "x-maipai-home-token: %s"\n' "$(tr -d '\n' < "$token_file")" > "$STACK_CURL_HOME/.curlrc"
  export CURL_HOME="$STACK_CURL_HOME"
}

# Stops the daemon: SIGTERM, wait up to 10 s, SIGKILL the whole process
# group, then confirm the port is free. The caller owns its scratch
# directory and removes it itself.
daemon_stop() {
  kill "$DAEMON_PID" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$DAEMON_PID" 2>/dev/null || break; sleep 0.5; done
  kill -9 -- "-$DAEMON_PID" 2>/dev/null || true
  if daemon_port_free "$PORT"; then echo "port $PORT free after stop"; else echo "port $PORT still held after stop"; fi
}
