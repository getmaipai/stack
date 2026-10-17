// The image tools' state (IMAGETOOLS-01): whether the environment is built,
// which model files are installed, whether Apple's foreground finder is in
// use, and the size limits, so Home can enable the editor's tools and word
// the limits. The edits themselves are POST /v1/images/edits.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { imageTools } from "@/imagetools/imageTools";

const StatusSchema = z.object({
  state: z.enum(["unsupported", "needs-setup", "building", "idle", "running"]).openapi({ description: "needs-setup: nothing is running; the first edit builds the environment (first time only) and starts the worker, which stops by itself when idle." }),
  phase: z.string().nullable(),
  vision: z.boolean().openapi({ description: "True once Apple's on-device foreground finder helper is built; background removal then uses it first." }),
  models: z.record(z.string(), z.boolean()).openapi({ description: "isnet, lama and esrgan: whether each pinned model file is installed and verified." }),
  limits: z.record(z.string(), z.number()).openapi({ description: "Megapixels each tool accepts." }),
  operations: z.array(z.string()),
  reason: z.string().nullable(),
});
const getRoute = createRoute({ method: "get", path: "/", tags: ["Image tools"], summary: "The image tools' state, models and limits", responses: { 200: { content: { "application/json": { schema: z.object({ image_tools: StatusSchema }) } }, description: "Additive. Home enables Remove background, Erase and Upscale from this." } } });

export const imageToolsRoutes = apiRouter<AppEnv>();
imageToolsRoutes.openapi(getRoute, (c) => c.json({ image_tools: imageTools.status() }, 200));
