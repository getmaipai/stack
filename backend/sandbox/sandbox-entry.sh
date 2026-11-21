#!/bin/bash
# The sandbox's first process (CODE-SANDBOX-02). It runs as root with CAP_NET_ADMIN, which the Stack adds to the machine for this
# step only. It loads the network lock, gives up the rights that could undo it for good, then starts the workload as the
# unprivileged user. If the lock does not load, it exits 70 and the workload never starts (fail closed).
#
# Environment (set by the Stack, never by the person):
#   SANDBOX_ALLOW_ADDR   the one IPv4 address the machine may reach (the gateway on the host-only network)
#   SANDBOX_ALLOW_PORTS  comma-separated TCP ports allowed on that address (may be empty)
#   SANDBOX_WORKLOAD_ENV base64 of NUL-separated NAME=value pairs the person set; exported to the workload only, after the rights are dropped
#   SANDBOX_USER         user for the workload (default agent; the gate test uses root to prove root cannot undo the lock)
# Arguments: the workload command.
set -u
# Nothing from outside decides which programs this root step runs: a fixed PATH, absolute paths below, and no loader or shell hooks.
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT BASH_ENV ENV CDPATH IFS
EXIT_LOCK=70
fail() { echo "sandbox-entry: $1" >&2; exit "$EXIT_LOCK"; }

addr="${SANDBOX_ALLOW_ADDR:-}"
ports="${SANDBOX_ALLOW_PORTS:-}"
user="${SANDBOX_USER:-agent}"
[ "$#" -gt 0 ] || set -- sleep infinity

[[ "$addr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail "SANDBOX_ALLOW_ADDR is missing or not an IPv4 address, so the network lock was not loaded. Check the sandbox network and start again."
[[ -z "$ports" || "$ports" =~ ^[0-9]{1,5}(,[0-9]{1,5})*$ ]] || fail "SANDBOX_ALLOW_PORTS must be comma-separated port numbers, so the network lock was not loaded."

allow_rule=""
[ -n "$ports" ] && allow_rule="ip daddr $addr tcp dport { $ports } accept"

# Default drop both ways. Loopback and replies to allowed traffic pass. Nothing else, no resolver.
/usr/sbin/nft -f - <<RULES || fail "the network lock rules did not load (is CAP_NET_ADMIN missing?), so the machine was not started."
flush ruleset
table inet sandbox_lock {
  chain input {
    type filter hook input priority 0; policy drop;
    iif "lo" accept
    ct state established,related accept
  }
  chain output {
    type filter hook output priority 0; policy drop;
    oif "lo" accept
    ct state established,related accept
    $allow_rule
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
  }
}
RULES
/usr/sbin/nft list table inet sandbox_lock >/dev/null 2>&1 || fail "the network lock was not found after loading, so the machine was not started."

mkdir -p /run && : > /run/sandbox-lock-ok || fail "could not write the lock marker, so the machine was not started."

# The person's variables, decoded now but handed over only in the final exec below (through env, so no shell evaluates the values).
person=()
if [ -n "${SANDBOX_WORKLOAD_ENV:-}" ]; then
  printf '%s' "$SANDBOX_WORKLOAD_ENV" | /bin/base64 -d >/dev/null 2>&1 || fail "SANDBOX_WORKLOAD_ENV could not be decoded, so the machine was not started."
  while IFS= read -r -d '' pair; do person+=("$pair"); done < <(printf '%s' "$SANDBOX_WORKLOAD_ENV" | /bin/base64 -d; printf '\0')
fi
unset SANDBOX_WORKLOAD_ENV
# Find the workload with the fixed PATH, because the person's PATH may point elsewhere.
case "$1" in */*) ;; *) found="$(command -v -- "$1")" && set -- "$found" "${@:2}" ;; esac

# Drop the rights that could undo the lock, for good (bounding set), then become the workload's user.
exec /usr/sbin/capsh --drop=cap_net_admin,cap_sys_admin,cap_sys_module,cap_net_raw --user="$user" -- -c 'exec /usr/bin/env "$@"' sandbox "${person[@]}" "$@"
