import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { getRoleStatus, openRoleSession, roleSessionActive, selectedModel, EngineUnavailableError } from "@/lib/supervisor";
import { identityHeaders } from "@/lib/identity";
import { decodeMouthWave, MOUTH_TIMINGS_MAX_SECONDS, mouthWords } from "@/speech/mouthTimings";
import { resampleLinear, WaveFormatError } from "@/speech/audio";
import { isLiveSpeechSessionActive } from "@/routes/speech";

const Form = z.object({ audio: z.custom<File>((value) => value instanceof File, "A WAV file in the `audio` field.").openapi({ type: "string", format: "binary" }), text: z.string().min(1).max(2000) });
const Word = z.object({ text: z.string(), start: z.number(), end: z.number() });
const Reply = z.object({ words: z.array(Word), recognizer: z.string(), duration_s: z.number() });
const Error = z.object({ error: z.string(), code: z.enum(["bad_audio", "busy", "no_timestamps", "not_ready"]) });
const route = createRoute({ method: "post", path: "/", tags: ["Speech"], summary: "Return word timings for a sentence of speech", request: { body: { content: { "multipart/form-data": { schema: Form } } } }, responses: { 200: { content: { "application/json": { schema: Reply } }, description: "Recognizer word timings in seconds." }, 400: { content: { "application/json": { schema: Error } }, description: "Unreadable WAV or audio longer than 30 seconds." }, 409: { content: { "application/json": { schema: Error } }, description: "The speech recognizer is busy with live or other speech." }, 501: { content: { "application/json": { schema: Error } }, description: "The recognizer does not provide token timestamps." }, 503: { content: { "application/json": { schema: Error } }, description: "The stt recognizer is not ready." } } });

let requestBusy = false;
export function __resetMouthTimingsForTests() { requestBusy = false; }
const respondError = (c: any, status: number, code: "bad_audio" | "busy" | "no_timestamps" | "not_ready", error: string) => c.json({ error, code }, status);
function asWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  const tag = (at: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE"); tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), true);
  return bytes;
}

export const mouthTimingsRoutes = apiRouter<AppEnv>();
mouthTimingsRoutes.openapi(route, async (c) => {
  const { audio } = c.req.valid("form");
  // `text` is intentionally only validated here: it is never sent to the worker or logged.
  let decoded: ReturnType<typeof decodeMouthWave>;
  try {
    const bytes = new Uint8Array(await audio.arrayBuffer());
    decoded = decodeMouthWave(bytes);
  } catch { return respondError(c, 400, "bad_audio", "Send a readable mono or stereo WAV file. If it is longer than 30 seconds, send one sentence at a time."); }
  const duration = decoded.samples.length / decoded.sampleRate;
  if (!Number.isFinite(duration) || duration <= 0 || duration > MOUTH_TIMINGS_MAX_SECONDS) return respondError(c, 400, "bad_audio", "Send a readable WAV file no longer than 30 seconds.");
  const status = getRoleStatus("stt");
  if (requestBusy || roleSessionActive("stt") || isLiveSpeechSessionActive() || status.state === "busy") return respondError(c, 409, "busy", "The speech recognizer is busy. Try mouth timings again after speech recognition finishes.");
  const model = selectedModel("stt");
  if (!model || status.state !== "ready") return respondError(c, 503, "not_ready", status.reason ?? "The stt speech recognizer is not ready. Start it from Home's Engines page, then try again.");
  requestBusy = true;
  let session: Awaited<ReturnType<typeof openRoleSession>> | null = null;
  try {
    session = await openRoleSession("stt");
    const samples = resampleLinear(decoded.samples, decoded.sampleRate, 16_000);
    const wav = asWav(samples);
    const response = await fetch(`${session.baseUrl}/v1/audio/transcriptions/timed-span`, { method: "POST", headers: { "content-type": "application/json", ...session.engineHeaders }, body: JSON.stringify({ audio_base64: Buffer.from(wav).toString("base64") }), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      if (response.status === 422) return respondError(c, 501, "no_timestamps", "The speech recognizer here does not report word times, so the mouth follows the voice level instead.");
      if (response.status >= 500) return respondError(c, 503, "not_ready", "The stt speech recognizer could not finish this request. Start it from Home's Engines page, then try again.");
      return respondError(c, 400, "bad_audio", "Send a readable WAV file. Check the audio and try again.");
    }
    const result = await response.json() as { tokens?: string[]; timestamps?: number[] };
    const words = mouthWords(result, samples.length / 16_000);
    if (!words) return respondError(c, 501, "no_timestamps", "The speech recognizer here does not report word times, so the mouth follows the voice level instead.");
    const headers = identityHeaders({ host: "local", build: "speech recognizer", model: model.id, healthy: true });
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
    return c.json({ words, recognizer: model.id, duration_s: Math.round((samples.length / 16_000) * 1000) / 1000 }, 200);
  } catch (error) {
    if (error instanceof WaveFormatError) return respondError(c, 400, "bad_audio", "Send a readable WAV file.");
    const reason = error instanceof EngineUnavailableError ? error.reason : "The stt speech recognizer is unavailable. Start it from Home's Engines page, then try again.";
    return respondError(c, 503, "not_ready", reason);
  } finally { session?.release(); requestBusy = false; }
});
