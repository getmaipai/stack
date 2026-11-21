#!/bin/bash
# The network gate of design code-app-refresh-2026-11-21 section 4 (CODE-SANDBOX-02), run INSIDE the machine as root after the
# lock is loaded. Prints one line per check, PASS or FAIL (or SKIP with the row that will cover it); exits 1 if any check fails.
# Environment:
#   GATE_GATEWAY         the allowed address (required)
#   GATE_ALLOWED_PORT    the one allowed port on it (required)
#   GATE_FORBIDDEN_PORT  a port the hub listens on that must stay unreachable (required)
#   GATE_LAN_ADDR        another device on the home network (optional; skipped when unset)
#   GATE_RAW_ADDR        an internet address to try by number (default 1.1.1.1)
set -u
bad=0
reach() { timeout 3 nc -z -w 2 "$1" "$2" >/dev/null 2>&1; }
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; bad=1; }

: "${GATE_GATEWAY:?GATE_GATEWAY is required}" "${GATE_ALLOWED_PORT:?GATE_ALLOWED_PORT is required}" "${GATE_FORBIDDEN_PORT:?GATE_FORBIDDEN_PORT is required}"

# Control: the one allowed port must still work, so a block is not just a dead network.
if reach "$GATE_GATEWAY" "$GATE_ALLOWED_PORT"; then pass "0 the allowed gateway port is reachable"; else fail "0 the allowed gateway port is not reachable"; fi
# 1. Any other hub port.
if reach "$GATE_GATEWAY" "$GATE_FORBIDDEN_PORT"; then fail "1 a hub port other than the allowed one is reachable"; else pass "1 hub ports other than the allowed one are blocked"; fi
# 2. Another device on the home network.
if [ -z "${GATE_LAN_ADDR:-}" ]; then echo "SKIP 2 no home network device given"
elif reach "$GATE_LAN_ADDR" 80 || reach "$GATE_LAN_ADDR" 22; then fail "2 a home network device is reachable"; else pass "2 home network devices are blocked"; fi
# 3. The internet by raw address.
if reach "${GATE_RAW_ADDR:-1.1.1.1}" 443; then fail "3 the internet is reachable by raw address"; else pass "3 the internet by raw address is blocked"; fi
# 4. A name lookup.
if getent hosts example.com >/dev/null 2>&1; then fail "4 a name lookup works"; else pass "4 name lookups fail"; fi
# 5. A host off the session's list through the proxy. TODO CODE-SANDBOX-02 (egress proxy slice): needs the proxy.
echo "SKIP 5 the egress proxy is not built yet (TODO CODE-SANDBOX-02, proxy slice)"
# Root must not be able to undo the lock.
if nft flush ruleset >/dev/null 2>&1; then fail "6 root could flush the lock"; else pass "6 root cannot flush the lock"; fi
if ip link set lo down >/dev/null 2>&1 || ip link set eth0 down >/dev/null 2>&1; then fail "7 root could take an interface down"; else pass "7 root cannot take an interface down"; fi
exit "$bad"
