// LOOK-01 step 3a: POST /v1/images/looks. One JPEG in, one look out, in memory. There is no route that returns a
// look by id (Robot vision R1); the answer to a request is the only copy and the Stack keeps no picture.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { LookError, lookService } from "@/look/look";

const FormSchema = z.object({
  image: z.custom<File>((value) => value instanceof File, "Send one JPEG picture.").openapi({ type: "string", format: "binary" }),
  source: z.string().min(1).max(200).openapi({ description: "Which camera this picture is from (a robot's device id). Only a key for the 90 second memory of what it has seen." }),
  detail: z.enum(["fast", "detailed"]).default("fast").openapi({ description: "`fast` names things with the on-computer detector. `detailed` is not available yet (422 detail_unavailable)." }),
});
const ErrorSchema = z.object({ error: z.string(), code: z.string() });
const ResultSchema = z.object({
  objects: z.array(z.object({ label: z.string(), count: z.number().int(), score: z.number(), box: z.array(z.number()), uncertain: z.literal(false), stale: z.literal(true).optional() })),
  scene: z.object({ light: z.enum(["dark", "dim", "bright"]), colours: z.array(z.string()), tags: z.array(z.object({ label: z.string(), score: z.number() })) }),
  cost: z.object({ ms: z.number(), tier: z.literal("fast") }),
  expires_in_s: z.number(),
});
const failure = (description: string) => ({ content: { "application/json": { schema: ErrorSchema } }, description });

const lookRoute = createRoute({
  method: "post",
  path: "/images/looks",
  tags: ["Roles"],
  summary: "Name what is in one picture (household objects, wall colour, light), in memory only",
  request: { body: { required: true, content: { "multipart/form-data": { schema: FormSchema } } } },
  responses: {
    200: { content: { "application/json": { schema: ResultSchema } }, description: "A LookResult (spec look-result) plus expires_in_s. Nothing is stored or logged but counts; ask again for a new look." },
    413: failure("The picture is over 2 MB."),
    415: failure("Not a complete JPEG."),
    422: failure("detail=detailed is not available yet."),
    429: failure("More than 12 pictures a minute from one source."),
    500: failure("Look failed."),
    503: failure("The Look part is not installed, not enough memory, or this computer cannot run it."),
  },
});

export const lookRoutes = apiRouter<AppEnv>();
lookRoutes.openapi(lookRoute, async (c) => {
  const form = c.req.valid("form");
  try {
    const result = await lookService.look(form.source, new Uint8Array(await form.image.arrayBuffer()), form.detail, c.req.raw.signal);
    return c.json(result, 200);
  } catch (error) {
    if (error instanceof LookError) return c.json({ error: error.message, code: error.code }, error.status as 500);
    return c.json({ error: "Look failed. Try again.", code: "failed" }, 500);
  }
});
