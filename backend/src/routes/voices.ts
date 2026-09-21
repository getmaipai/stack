// The voice list (STACK-101a) and the voice preview (STACK-101c):
// every voice the tts role can render, with its metadata, and one fixed
// sentence rendered per voice so a person can hear it before committing.
import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, errorResponses } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { dataDir } from "@/lib/paths";
import { identityHeaders } from "@/lib/identity";
import { POCKET_TTS_VERSION } from "@/speech/pocketTts";
import { listVoices } from "@/speech/voiceList";
import { ensureCloningWeights, prepareVoice, voiceNeedsCloning, VoiceRefusedError } from "@/speech/voices";
import { speakRole, speechForm } from "@/lib/supervisor";
import { Voice } from "@/spec/ts/voice";

const ListVoicesSchema = z.object({ voices: z.array(Voice) });
const PreviewSentence = "Hello, this is my voice.";

const previewDir = join(dataDir, "voice-previews");

function previewPath(voiceId: string): string {
  return join(previewDir, `${voiceId}__${POCKET_TTS_VERSION}.wav`);
}

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Voices"],
  summary: "Voices the tts role can render, with metadata",
  responses: {
    200: {
      content: { "application/json": { schema: ListVoicesSchema } },
      description: "Every voice with its declared metadata.",
    },
  },
});

const previewRoute = createRoute({
  method: "post",
  path: "/{id}/preview",
  tags: ["Voices"],
  summary: "Render the preview sentence for one voice",
  responses: {
    200: {
      content: { "audio/wav": { schema: z.string().openapi({ format: "binary" }) } },
      description: "The preview sentence in this voice, rendered once and served from disk thereafter.",
    },
    ...errorResponses({
      400: "Unknown role or model id, or a voice the Stack cannot pin and verify (reason voice-not-pinnable).",
      404: "The voice id is not one this engine can render.",
      409: "The voice needs voice cloning that is off or has no token (reason voice-cloning-unavailable).",
      500: "The engine could not render the preview.",
    }),
  },
});

export const voicesRoutes = apiRouter<AppEnv>();
voicesRoutes.openapi(listRoute, (c) => c.json({ voices: listVoices() }, 200));
voicesRoutes.openapi(previewRoute, async (c) => {
  const { id } = c.req.param();
  const voice = listVoices().find((v) => v.id === id);
  if (!voice) return c.json({ error: `Voice '${id}' is not one this engine can render.` }, 404);
  const path = previewPath(id);
  if (existsSync(path)) {
    const bytes = await fs.readFile(path);
    return new Response(bytes, { status: 200, headers: { "content-type": "audio/wav", "cache-control": "no-cache", ...identityHeaders(null) } });
  }
  try {
    await fs.mkdir(previewDir, { recursive: true });
    const voiceUrl = id.replace(/^pocket-tts-voice-/, "");
    const prepared = await prepareVoice(voiceUrl, {});
    if (voiceNeedsCloning(prepared)) {
      const fetched = await ensureCloningWeights({});
      if (!fetched) throw new VoiceRefusedError("This voice needs the voice-cloning weights, which Hugging Face keeps behind a token; set stack.engines.tts.hf_token, turn on stack.engines.tts.voice_cloning and restart the voice engine.", 409, "voice-cloning-unavailable");
    }
    const spoken = await speakRole("tts", speechForm(PreviewSentence, prepared));
    if (!spoken.body) return c.json({ error: spoken.status === 499 ? "Request cancelled" : spoken.status === 504 ? "The engine timed out." : "The engine did not answer." }, 500);
    const chunks: Uint8Array[] = [];
    const reader = spoken.body.getReader();
    for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); }
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const wav = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { wav.set(chunk, offset); offset += chunk.byteLength; }
    await fs.writeFile(path, wav);
    const headers: Record<string, string> = { "content-type": spoken.contentType ?? "audio/wav", "cache-control": "no-cache", ...spoken.headers, ...identityHeaders(null) };
    return new Response(wav, { status: spoken.status, headers });
  } catch (error) {
    if (error instanceof VoiceRefusedError) return c.json({ error: error.message, reason: error.reason }, error.status);
    return c.json({ error: error instanceof Error ? error.message : "The preview could not be rendered." }, 500);
  }
});
