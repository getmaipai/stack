"""SEARCH-DDGS-01 / STACK-DDGS-01: the ddgs search sidecar, owned and supervised by the Stack.

A tiny local HTTP service around the maintained `ddgs` library. Home (lib/retrieval/ddgsSource.ts)
is its only caller. The library owns the browser-like client: this file passes it no proxy, builds
ONE client for the life of the process and reuses it, and never rotates or picks an identity.
Requests that carry an Origin header (a web page) or a Host other than loopback are refused, so only
a local program such as Home can use it.

    GET /health                    ->  200 {"ok":true}   the Stack's readiness check; searches nothing
    GET /search?q=<words>&max=<n>  ->  200 {"rows":[{"title","url","snippet"}]}
                                       429 {"error":"blocked"}   the engine pushed back; Home goes quiet
                                       502 {"error":"failed"}    anything else

Binds 127.0.0.1 only. Logs nothing about the words searched.
Run by the Stack (STACK-DDGS-01) from its managed Python environment; port from DDGS_SIDECAR_PORT.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from ddgs import DDGS
from ddgs.exceptions import DDGSException, RatelimitException

MAX_ROWS = 10
CLIENT = DDGS()  # one client for the process: one identity, no per-request rotation
BLOCK_WORDS = ("ratelimit", "rate limit", "429", "403", "202", "captcha", "blocked", "bot")


def search(query: str, limit: int) -> list[dict]:
    try:
        hits = CLIENT.text(query, max_results=limit)
    except RatelimitException:
        raise
    except DDGSException as err:
        text = str(err).lower()
        if "no results" in text:
            return []
        if any(word in text for word in BLOCK_WORDS):
            raise RatelimitException(str(err)) from err
        raise
    return [
        {"title": h.get("title", ""), "url": h.get("href", ""), "snippet": h.get("body", "")}
        for h in hits
    ]


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        if self.headers.get("Origin") or host not in ("127.0.0.1", "localhost", "[::1]"):
            return self._send(403, {"error": "local callers only"})
        url = urlparse(self.path)
        if url.path == "/health":
            return self._send(200, {"ok": True})
        if url.path != "/search":
            return self._send(404, {"error": "not found"})
        params = parse_qs(url.query)
        query = (params.get("q") or [""])[0].strip()
        if not query:
            return self._send(400, {"error": "q is required"})
        try:
            limit = max(1, min(MAX_ROWS, int((params.get("max") or ["8"])[0])))
        except ValueError:
            limit = 8
        try:
            self._send(200, {"rows": search(query, limit)})
        except RatelimitException:
            self._send(429, {"error": "blocked"})
        except Exception:
            self._send(502, {"error": "failed"})

    def log_message(self, *args) -> None:  # never log requests: they hold the words searched
        pass


if __name__ == "__main__":
    port = int(os.environ.get("DDGS_SIDECAR_PORT", "8793"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
