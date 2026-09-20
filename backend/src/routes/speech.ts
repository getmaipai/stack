// The live speech session, WS /v1/audio/transcriptions/stream: the Stack
// upgrades the socket, opens a session on the stt process, and passes
// frames both ways unchanged (binary audio in, spec/voice's SttWireEvent
// text frames out). No frame is parsed here; the worker owns the
// contract, and a session ending, however it ends, releases the process
// for the drain.
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { EngineUnavailableError, openRoleSession, type RoleSession } from "@/lib/supervisor";
import { SESSION_PATH } from "@/speech/server";

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
export { websocket };

export const speechRoutes = new Hono();

speechRoutes.get("/", upgradeWebSocket(() => {
  let upstream: WebSocket | null = null;
  let session: RoleSession | null = null;
  let closed = false;
  // Frames that arrive before the upstream socket is open are held, so
  // the first words of an utterance are never dropped.
  const held: Array<string | ArrayBuffer | Uint8Array> = [];
  const end = () => { closed = true; session?.release(); session = null; if (upstream && upstream.readyState <= 1) upstream.close(); upstream = null; };
  return {
    async onOpen(_event, client) {
      let opened: RoleSession;
      try {
        // The process retiring under this session (a stop, a restart)
        // ends it from the server side, so the drain never waits on a
        // client that would stream forever.
        opened = await openRoleSession("stt", () => {
          if (closed) return;
          // Said as an event, then a normal close: 1012 is not a code a
          // server may send through every websocket stack.
          client.send(JSON.stringify({ t: "error", v: "The stt engine is restarting." }));
          end();
          client.close(1000, "The stt engine is restarting.");
        });
      } catch (error) {
        const reason = error instanceof EngineUnavailableError ? error.reason : (error as Error).message;
        if (!closed) { client.send(JSON.stringify({ t: "error", v: reason })); client.close(1011, "No stt engine is ready."); }
        return;
      }
      // The client may have left while the worker was loading; the
      // session is released at once rather than held forever.
      if (closed) { opened.release(); return; }
      session = opened;
      const socket = new WebSocket(`${session.baseUrl.replace(/^http/, "ws")}${SESSION_PATH}`);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => { for (const frame of held) socket.send(frame as ArrayBuffer); held.length = 0; };
      socket.onmessage = (message) => { if (typeof message.data === "string") client.send(message.data); };
      // Once this side has ended the session, the upstream's own close
      // is the echo of ours, not a new reason to give the client.
      socket.onclose = () => { if (closed) return; end(); client.close(1000, "Session ended."); };
      socket.onerror = () => { if (closed) return; client.send(JSON.stringify({ t: "error", v: "The stt engine dropped the session." })); end(); client.close(1011, "The stt engine dropped the session."); };
      upstream = socket;
    },
    onMessage(event) {
      const data = event.data as string | ArrayBuffer | Uint8Array;
      if (upstream && upstream.readyState === 1) upstream.send(data as ArrayBuffer);
      else held.push(data);
    },
    onClose() { end(); },
    onError() { end(); },
  };
}));
