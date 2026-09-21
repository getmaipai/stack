// The speech worker's loopback server: what the supervisor probes, what
// the Stack's audio routes forward to. Its identity endpoints wear
// llama-server's shape (`/health` answering `status: ok`, `/props` with
// `build_info` and `model_path`) so the supervisor's one identity reader
// serves both engines; the transcription endpoint takes the spec's
// multipart form or, from the Stack's own route and probe, JSON with
// the WAV in base64; the session endpoint is spec/voice's SttWireEvent
// contract. The engines are injected: the worker hands in sherpa-onnx,
// the suite hands in scripted ones.
import type { ServerWebSocket } from "bun";
import { decodeWave, frameToSamples, toRecognizerRate, WaveFormatError } from "@/speech/audio";
import { SttSession, type SttSessionConfig, type Transcriber, type VoiceDetector } from "@/speech/session";
import type { SttWireEvent } from "@maipai/spec/stack/ts/stt-wire-event.js";

export const SESSION_PATH = "/v1/audio/transcriptions/stream";
export const TRANSCRIBE_PATH = "/v1/audio/transcriptions";

export interface SpeechServerOptions {
  port: number;
  build: string;
  modelPath: string;
  transcriber: Transcriber;
  detector: () => VoiceDetector;
  session?: Partial<SttSessionConfig>;
}

interface SocketData { session: SttSession | null; }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The WAV bytes from either shape the endpoint accepts. */
async function wavFromRequest(request: Request): Promise<Uint8Array | null> {
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    return file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : null;
  }
  if (type.startsWith("application/json")) {
    const body = await request.json().catch(() => null) as { audio_base64?: unknown } | null;
    return typeof body?.audio_base64 === "string" ? Uint8Array.from(Buffer.from(body.audio_base64, "base64")) : null;
  }
  return null;
}

export function startSpeechServer(options: SpeechServerOptions) {
  const server = Bun.serve<SocketData>({
    port: options.port,
    hostname: "127.0.0.1",
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return jsonResponse({ status: "ok" });
      if (request.method === "GET" && url.pathname === "/props") return jsonResponse({ build_info: options.build, model_path: options.modelPath });
      if (url.pathname === SESSION_PATH) {
        if (bunServer.upgrade(request, { data: { session: null } })) return undefined;
        return jsonResponse({ error: "This path is a websocket session." }, 426);
      }
      if (request.method === "POST" && url.pathname === TRANSCRIBE_PATH) {
        const wav = await wavFromRequest(request);
        if (!wav) return jsonResponse({ error: "Send a 16-bit PCM WAV as the multipart field `file`, or JSON with `audio_base64`." }, 400);
        try {
          const text = await options.transcriber.transcribe(toRecognizerRate(decodeWave(wav)));
          return jsonResponse({ text });
        } catch (error) {
          if (error instanceof WaveFormatError) return jsonResponse({ error: error.message }, 400);
          return jsonResponse({ error: (error as Error).message }, 500);
        }
      }
      return jsonResponse({ error: "Not found." }, 404);
    },
    websocket: {
      open(socket: ServerWebSocket<SocketData>) {
        const send = (event: SttWireEvent) => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); };
        socket.data.session = new SttSession({ transcriber: options.transcriber, detector: options.detector(), send, config: options.session });
        send({ t: "ready" });
      },
      message(socket: ServerWebSocket<SocketData>, message: string | Buffer) {
        const session = socket.data.session;
        if (!session) return;
        if (typeof message === "string") {
          const parsed = (() => { try { return JSON.parse(message) as { t?: unknown }; } catch { return null; } })();
          if (parsed?.t === "end") session.end();
          return;
        }
        session.pushPcm(frameToSamples(message));
      },
      close(socket: ServerWebSocket<SocketData>) {
        socket.data.session?.close();
        socket.data.session = null;
      },
    },
  });
  return server;
}
