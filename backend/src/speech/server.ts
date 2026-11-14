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
import { checkEngineCaller } from "@/lib/loopbackGuard";
import { decodeWave, frameToSamples, toRecognizerRate, WaveFormatError } from "@/speech/audio";
import { SttSession, type SttSessionConfig, type Transcriber, type VoiceDetector } from "@/speech/session";
import type { SttWireEvent } from "@maipai/spec/stack/ts/stt-wire-event.js";

export const SESSION_PATH = "/v1/audio/transcriptions/stream";
export const TRANSCRIBE_PATH = "/v1/audio/transcriptions";
export const TRANSCRIBE_TIMED_PATH = "/v1/audio/transcriptions/timed-span";
export const TRANSCRIBE_SPANS_PATH = "/v1/audio/transcriptions/detect-spans";

export const DIARIZE_PATH = "/v1/audio/transcriptions/diarize";
export const SPEAKER_EMBEDDING_PATH = "/v1/audio/speaker-embedding";

export interface SpeechServerOptions {
  port: number;
  /** The launch key the Stack made for this worker (ISOLATION-04b); unset only when the worker is started by hand. */
  key?: string;
  build: string;
  modelPath: string;
  transcriber: Transcriber;
  detector: () => VoiceDetector;
  /** Speaker detection; null when its models are not installed. */
  diarizer?: () => { diarize(samples: Float32Array, numSpeakers?: number): Array<{ start: number; end: number; speaker: number }> } | null;
  speakerEmbedder?: () => { readonly dim: number; embed(samples: Float32Array): number[] } | null;
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

async function embeddingSamples(request: Request): Promise<Float32Array | null> {
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("audio/wav") || type.startsWith("audio/x-wav")) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    return toRecognizerRate(decodeWave(bytes));
  }
  if (type.startsWith("audio/pcm;")) {
    if (!/rate=16000/.test(type) || !/channels=1/.test(type)) return null;
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (/format=float32/.test(type)) {
      if (bytes.length % 4) return null;
      const aligned = new Uint8Array(bytes.length); aligned.set(bytes); return new Float32Array(aligned.buffer);
    }
    if (/format=s16le/.test(type)) {
      if (bytes.length % 2) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), samples = new Float32Array(bytes.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      return samples;
    }
  }
  if (type.startsWith("audio/wav") || type.startsWith("audio/x-wav")) return toRecognizerRate(decodeWave(new Uint8Array(await request.arrayBuffer())));
  const wav = await wavFromRequest(request);
  return wav ? toRecognizerRate(decodeWave(wav)) : null;
}

export function startSpeechServer(options: SpeechServerOptions) {
  const server = Bun.serve<SocketData>({
    port: options.port,
    hostname: "127.0.0.1",
    async fetch(request, bunServer) {
      const refused = checkEngineCaller(request, options.key);
      if (refused) return refused;
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
      if (request.method === "POST" && url.pathname === TRANSCRIBE_TIMED_PATH) {
        const body = await request.json().catch(() => null) as { audio_base64?: unknown; hotwords?: unknown } | null;
        if (typeof body?.audio_base64 !== "string") return jsonResponse({ error: "Send audio_base64 containing a 16 kHz WAV." }, 400);
        const detailed = (options.transcriber as typeof options.transcriber & { transcribeTimed?: (samples: Float32Array, hotwords?: string) => Promise<{ text: string; lang?: string; tokens?: string[]; timestamps?: number[]; ys_log_probs?: number[] }> }).transcribeTimed;
        if (!detailed) return jsonResponse({ error: "Token timing is not available for the installed speech model." }, 422);
        try {
          const decoded = decodeWave(Uint8Array.from(Buffer.from(body.audio_base64, "base64")));
          const result = await detailed(toRecognizerRate(decoded), typeof body.hotwords === "string" ? body.hotwords : undefined);
          return jsonResponse(result);
        } catch (error) {
          if (error instanceof WaveFormatError) return jsonResponse({ error: error.message }, 400);
          return jsonResponse({ error: "The speech engine could not transcribe this span." }, 500);
        }
      }
      if (request.method === "POST" && url.pathname === TRANSCRIBE_SPANS_PATH) {
        const body = await request.json().catch(() => null) as { audio_base64?: unknown } | null;
        if (typeof body?.audio_base64 !== "string") return jsonResponse({ error: "Send audio_base64 containing a 16 kHz WAV." }, 400);
        try {
          const decoded = decodeWave(Uint8Array.from(Buffer.from(body.audio_base64, "base64")));
          const detector = options.detector(); detector.reset();
          const { splitSpeechSpans } = await import("@/speech/transcriptSpans");
          return jsonResponse({ spans: splitSpeechSpans(toRecognizerRate(decoded), detector) }, 200);
        } catch (error) {
          if (error instanceof WaveFormatError) return jsonResponse({ error: error.message }, 400);
          return jsonResponse({ error: "Speech spans could not be detected." }, 500);
        }
      }
      if (request.method === "POST" && url.pathname === DIARIZE_PATH) {
        // The extracted audio is a wav file the daemon wrote on this computer (a 3 hour file is too big for a request body).
        const body = await request.json().catch(() => null) as { audio_path?: unknown; num_speakers?: unknown } | null;
        if (typeof body?.audio_path !== "string" || !body.audio_path.endsWith(".wav") || !body.audio_path.startsWith("/")) return jsonResponse({ error: "Send audio_path: the absolute path of a 16 kHz WAV file." }, 400);
        const engine = options.diarizer?.() ?? null;
        if (!engine) return jsonResponse({ error: "Speaker detection models are not installed.", code: "unavailable" }, 422);
        try {
          const decoded = decodeWave(new Uint8Array(await Bun.file(body.audio_path).arrayBuffer()));
          const turns = engine.diarize(toRecognizerRate(decoded), typeof body.num_speakers === "number" ? body.num_speakers : undefined);
          return jsonResponse({ turns }, 200);
        } catch (error) {
          if (error instanceof WaveFormatError) return jsonResponse({ error: error.message }, 400);
          return jsonResponse({ error: "Speakers could not be detected in this audio." }, 500);
        }
      }
      if (request.method === "POST" && url.pathname === SPEAKER_EMBEDDING_PATH) {
        const started = performance.now();
        try {
          const samples = await embeddingSamples(request);
          if (!samples) return jsonResponse({ error: "Send a 16-bit PCM WAV, or raw 16 kHz mono float32 or s16le PCM with its content type." }, 400);
          const duration = samples.length / 16_000;
          if (duration > 15) return jsonResponse({ error: "Audio must be 15 seconds or shorter. Trim the clip and try again." }, 413);
          if (duration < 1) return jsonResponse({ error: "Audio must contain at least one second of speech-length audio." }, 422);
          const engine = options.speakerEmbedder?.() ?? null;
          if (!engine) return jsonResponse({ error: "The speaker embedding model is not installed. Install titanet-small-en from Home's Engines page, then try again.", code: "component_not_ready" }, 503);
          const embedding = engine.embed(samples);
          if (embedding.length !== engine.dim) return jsonResponse({ error: "The speaker embedding model returned an invalid vector." }, 500);
          console.log(`speaker-embedding duration_s=${duration.toFixed(3)} status=ok ms=${Math.round(performance.now() - started)}`);
          return jsonResponse({ model_id: "nemo-titanet-small-v1", dim: engine.dim, embedding });
        } catch (error) {
          if (error instanceof WaveFormatError) return jsonResponse({ error: error.message }, 400);
          console.log(`speaker-embedding status=failed ms=${Math.round(performance.now() - started)}`);
          return jsonResponse({ error: "A speaker embedding could not be calculated for this audio." }, 500);
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
