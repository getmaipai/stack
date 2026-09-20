// The voice list (STACK-101a): every voice the tts role can render, with
// its metadata, so Home's voice picker can show a friendly name and filter
// by language, country and gender without guessing.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { listVoices } from "@/speech/voiceList";
import { Voice } from "@/spec/ts/voice";

const ListVoicesSchema = z.object({ voices: z.array(Voice) });

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

export const voicesRoutes = apiRouter<AppEnv>();
voicesRoutes.openapi(listRoute, (c) => c.json({ voices: listVoices() }, 200));
