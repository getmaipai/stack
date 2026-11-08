"""ISOLATION-04b: who may talk to an engine the Stack starts.

An engine listens on a random port of 127.0.0.1, and loopback is not private from a web page: a page can send requests to it (CSRF)
and a page whose name is re-pointed at 127.0.0.1 (DNS rebinding) can read the answers. The Stack starts every engine with a new key
(the STACK_ENGINE_KEY environment variable) and sends it as `Authorization: Bearer <key>`. Three checks, in this order:
  1. Host must be 127.0.0.1, localhost or [::1] (a port is fine). A rebound name is none of them: 421.
  2. No Origin header. The Stack and Home are programs; a page always sends one: 403.
  3. The key, on every route but GET /health (the Stack's liveness probe): 401.
No key in the environment means the script was started by hand, outside the Stack: only checks 1 and 2 apply.
`refusal` takes plain values so the HTTP server of each engine can call it.
"""
import hmac
import os
import re

KEY = os.environ.get("STACK_ENGINE_KEY", "")
_HOST = re.compile(r"(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?")
_BEARER = re.compile(r"Bearer (.+)")


def refusal(method, path, host, origin, authorization, key=None):
    """(status, code, message) for a request the engine must not answer, or None."""
    key = KEY if key is None else key
    match = _HOST.fullmatch((host or "").strip().lower())
    if not match or match.group(1) not in ("127.0.0.1", "localhost", "[::1]"):
        return (421, "host_not_allowed", "This engine answers only to 127.0.0.1 or localhost.")
    if origin is not None:
        return (403, "origin_not_allowed", "This engine does not take requests from a web page. Use the Stack, which makes them for you.")
    if not key or (method == "GET" and path.split("?", 1)[0] == "/health"):
        return None
    given = _BEARER.fullmatch(authorization or "")
    if given and hmac.compare_digest(given.group(1).encode(), key.encode()):
        return None
    return (401, "engine_key_required", "This engine takes requests only from the Stack, with the key the Stack made when it started the engine.")
