"""Pocket TTS behind the Stack's engine guard (ISOLATION-04b).

`pocket-tts serve` has no key option, so the Stack starts it through this file: the same server (pocket_tts.main.serve, same model
loading, same app) with engine_guard's checks placed in front of every route, HTTP and websocket. Started as
`python pocket_tts_server.py --port <n>`; the key comes from STACK_ENGINE_KEY.
"""
import json
import sys

import engine_guard
from pocket_tts import main as pocket


class EngineGuard:
    """ASGI middleware: refuses a caller engine_guard refuses before any route (or the CORS layer) sees it."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
            method = scope.get("method", "GET") if scope["type"] == "http" else "GET"
            bad = engine_guard.refusal(method, scope.get("path", ""), headers.get("host"), headers.get("origin"), headers.get("authorization"))
            if bad:
                if scope["type"] == "websocket":
                    return await send({"type": "websocket.close", "code": 1008})
                status, code, message = bad
                body = json.dumps({"error": message, "code": code}).encode()
                extra = [(b"www-authenticate", b"Bearer")] if status == 401 else []
                await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), *extra]})
                return await send({"type": "http.response.body", "body": body})
        await self.app(scope, receive, send)


def main():
    port = int(sys.argv[sys.argv.index("--port") + 1])
    pocket.web_app.add_middleware(EngineGuard)  # added last, so it is outermost: it runs before the CORS layer
    pocket.serve(host="127.0.0.1", port=port, reload=False)  # the other options keep their own defaults, as `pocket-tts serve --host --port` did


if __name__ == "__main__":
    main()
