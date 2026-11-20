import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { enhanceAdapterInstalled, enhanceRefusal, EnhanceRefusal } from "@/video/enhance";

const ErrorBody = z.object({ error: z.string() });
const Request = z.object({ source_video: z.any().optional() });
const post = createRoute({
  method: "post", path: "/enhance", tags: ["Video"], summary: "Refine the details of a finished clip (refused until the adapter is installed)",
  description: "VF-ENHANCE-01 door. The clip is checked first (422 with a plain line), then the Stack refuses with `not_installed` (409) until the Refine Details adapter is a pinned, installed part. Nothing is stored and no model runs on a refusal.",
  request: { body: { content: { "multipart/form-data": { schema: Request } } } },
  responses: {
    409: { content: { "application/json": { schema: EnhanceRefusal } }, description: "The adapter is not installed; the clip is unchanged." },
    422: { content: { "application/json": { schema: ErrorBody } }, description: "The clip was not sent, or is not an MP4." },
    503: { content: { "application/json": { schema: ErrorBody } }, description: "The adapter is installed but the operation is not wired on this build." },
  },
});
export const videoEnhanceRoutes = apiRouter<AppEnv>();
videoEnhanceRoutes.openapi(post, async (c) => {
  const form = await c.req.parseBody({ all: true });
  const source = form.source_video;
  if (!(source instanceof File)) return c.json({ error: "Send the clip to refine as source_video." }, 422);
  if (!source.name.toLowerCase().endsWith(".mp4") || (source.type && source.type !== "video/mp4")) return c.json({ error: "Send the clip as an MP4 file." }, 422);
  if (!enhanceAdapterInstalled()) return c.json(enhanceRefusal(), 409);
  return c.json({ error: "Refine Details is installed but not wired into this build yet. Update the Stack and try again." }, 503);
});
