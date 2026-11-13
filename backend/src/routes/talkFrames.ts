import { admissionCaller } from "@/lib/admissionCaller";
// POST /v1/images/talk-frames (TALK-06): mouth and eye still frames for one
// portrait, as a job (202, poll /stack/v1/jobs/{id}, fetch each PNG by index),
// the same model as POST /v1/images/edits. Results wait ten minutes in memory.
//
// Safety posture: no identity, face-matching, age or sexual-content decision
// lives here. Home decides who may call this route and screens every picture
// before it is sent. No picture, ratio list or result is logged.
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { apiRouter } from "@maipai/core/src/openapi";
import { RoleReplyHeaders } from "@maipai/spec/stack/ts/role-reply-headers.js";
import type { AppEnv } from "@/types";
import { identityHeaders } from "@/lib/identity";
import { hasJobRunner, submitJob, waitForJob } from "@/lib/jobs";
import { LIVEPORTRAIT_LIMITS, stashTalkInput, takeTalkResult } from "@/liveportrait/liveportrait";
import type { TalkFramesJobResult } from "@/liveportrait/jobs";

const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const DEFAULT_WAIT_MS = 120_000;
const BAD_RATIOS = `Send lip and eye as comma-separated numbers from 0 to 1, at most ${LIVEPORTRAIT_LIMITS.max_ratios_per_list} values each and at least one in all. For example lip=0,0.3,0.7 and eye=0.`;

/** Comma-separated floats 0 to 1, at most 12; an empty string is an empty list; null when it is not acceptable. */
export function parseRatioList(text: string | undefined): number[] | null {
  if (text === undefined || text.trim() === "") return [];
  const values = text.split(",").map((part) => part.trim());
  if (values.length > LIVEPORTRAIT_LIMITS.max_ratios_per_list || values.some((part) => part === "" || !Number.isFinite(Number(part)))) return null;
  const numbers = values.map(Number);
  return numbers.every((value) => value >= 0 && value <= 1) ? numbers : null;
}

const FormSchema = z.object({
  image: z.custom<File>((value) => value instanceof File, "A picture is required.").openapi({ type: "string", format: "binary", description: "A portrait (PNG, JPEG or WebP), at most 16 megapixels. Home screens it before sending." }),
  lip: z.string().optional().openapi({ example: "0,0.3,0.7", description: "Mouth-openness ratios, comma separated, each 0 (closed) to 1, at most 12." }),
  eye: z.string().optional().openapi({ example: "0", description: "Eye-openness ratios, comma separated, each 0 (closed) to 1, at most 12." }),
  timeout_ms: z.coerce.number().int().positive().optional(),
});
const PointsSchema = z.array(z.tuple([z.number(), z.number()]));
const LandmarksSchema = z.object({ outerLips: PointsSchema, innerLips: PointsSchema, nose: PointsSchema, contour: PointsSchema, points: PointsSchema }).openapi({ description: "Face landmarks from the 203-point landmark model (MIT, the model the engine already runs; not Apple Vision), `[x, y]` in the picture's pixels, the same space as the returned frames. `outerLips` is 36 points, `innerLips` 24, `points` all 203. `nose` and `contour` are empty until the model's index layout for them is confirmed; take them from `points` meanwhile." });
const FrameSchema = z.object({ kind: z.enum(["lip", "eye"]), ratio: z.number(), width: z.number(), height: z.number(), content_type: z.literal("image/png"), ms: z.number(), url: z.string(), landmarks: LandmarksSchema.nullable().optional().openapi({ description: "This frame's landmarks; null when the face finder sees no face in the frame." }) });
const ResponseSchema = z.object({ created: z.number().int().optional(), job: z.string(), sourceEye: z.number().optional(), sourceLip: z.number().optional(), sourceLandmarks: LandmarksSchema.nullable().optional().openapi({ description: "The input picture's own landmarks." }), frames: z.array(FrameSchema) });
const ErrorSchema = z.object({ error: z.string(), code: z.string().optional(), job: z.string().optional() });

const postRoute = createRoute({
  method: "post", path: "/images/talk-frames", tags: ["Roles"], summary: "Mouth and eye still frames for a portrait (the job API with a wait)",
  request: { body: { content: { "multipart/form-data": { schema: FormSchema } } } },
  responses: {
    200: { content: { "application/json": { schema: ResponseSchema } }, description: "One entry per requested ratio: every lip ratio first (with the picture's own eye openness), then every eye ratio (with its own lip openness), in the order sent. `sourceEye` and `sourceLip` are the picture's own measured ratios. Fetch each PNG from `url`; frames are the input picture's size." },
    202: { content: { "application/json": { schema: ResponseSchema } }, description: "Still running past timeout_ms; poll /stack/v1/jobs/{job} (its result holds `frameCount`, `width`, `height`, `sourceEye`, `sourceLip`), then fetch frame 0 to frameCount-1 from GET /v1/images/talk-frames/{job}/{index}, in the order the ratios were sent: every lip ratio, then every eye ratio." },
    413: { content: { "application/json": { schema: ErrorSchema } }, description: "The upload is too big, or the picture is over 16 megapixels." },
    422: { content: { "application/json": { schema: ErrorSchema } }, description: "Bad ratios, an unreadable picture, or no face found (`no_face`); `error` says what to change." },
    500: { content: { "application/json": { schema: ErrorSchema } }, description: "The engine failed on this picture." },
    503: { content: { "application/json": { schema: ErrorSchema } }, description: "The engine or its model files are not installed, or there is no free memory; `error` says what to do." },
  },
});
const frameRoute = createRoute({
  method: "get", path: "/images/talk-frames/{job}/{index}", tags: ["Roles"], summary: "One finished frame as a PNG (kept in memory for ten minutes)",
  request: { params: z.object({ job: z.string(), index: z.coerce.number().int().nonnegative() }) },
  responses: { 200: { content: { "image/png": { schema: z.string().openapi({ format: "binary" }) } }, description: "One frame, the input picture's size, no metadata." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "No such frame (it expired after ten minutes or was never made)." } },
});

function reply(c: Context, body: unknown, status: number) {
  for (const [name, value] of Object.entries(RoleReplyHeaders.parse(identityHeaders(null)))) c.header(name, value);
  return c.json(body as never, status as never);
}

export const talkFramesRoutes = apiRouter<AppEnv>();
talkFramesRoutes.openapi(postRoute, async (c) => {
  const form = c.req.valid("form");
  const lip = parseRatioList(form.lip), eye = parseRatioList(form.eye);
  if (!lip || !eye || lip.length + eye.length === 0) return reply(c, { error: BAD_RATIOS, code: "bad_ratio" }, 422) as never;
  if (form.image.size === 0) return reply(c, { error: "A picture is required. Send a JPEG, PNG or WebP portrait.", code: "bad_image" }, 422) as never;
  if (form.image.size > MAX_UPLOAD_BYTES) return reply(c, { error: `The picture must be smaller than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, code: "too_large" }, 413) as never;
  if (!hasJobRunner("talk_frames")) return reply(c, { error: "Talking pictures are not available on this machine.", code: "unsupported" }, 503) as never;
  const token = crypto.randomUUID();
  stashTalkInput(token, { image: new Uint8Array(await form.image.arrayBuffer()), lip, eye });
  const submitted = submitJob({ caller: admissionCaller(c), kind: "talk_frames", role: "image", input: { token } });
  if ("refused" in submitted) return reply(c, { error: submitted.reason, code: submitted.code ?? "unsupported" }, 503) as never;
  const created = Math.floor(new Date(submitted.job.createdAt).getTime() / 1000);
  const settled = await waitForJob(submitted.job.id, form.timeout_ms ?? DEFAULT_WAIT_MS);
  if (!settled || settled.state === "queued" || settled.state === "running") return reply(c, { created, job: submitted.job.id, frames: [] }, 202) as never;
  if (settled.state === "cancelled") return reply(c, { error: "The talking frames were cancelled.", code: "cancelled", job: settled.id }, 499) as never;
  const outcome = settled.result as TalkFramesJobResult | null;
  if (outcome?.rejected) return reply(c, { error: outcome.rejected.message, code: outcome.rejected.code, job: settled.id }, outcome.rejected.status) as never;
  if (settled.state !== "done") return reply(c, { error: settled.reason ?? "The talking frames could not be made. Try again.", code: "failed", job: settled.id }, 500) as never;
  const kept = takeTalkResult(settled.id);
  if (!kept) return reply(c, { error: "The result is no longer held; send the picture again.", code: "expired", job: settled.id }, 500) as never;
  return reply(c, { created, job: settled.id, sourceEye: kept.sourceEye, sourceLip: kept.sourceLip, ...(kept.sourceLandmarks !== undefined ? { sourceLandmarks: kept.sourceLandmarks } : {}), frames: kept.frames.map((frame, index) => ({ kind: frame.kind, ratio: frame.ratio, width: kept.width, height: kept.height, content_type: "image/png" as const, ms: frame.ms, url: `/v1/images/talk-frames/${settled.id}/${index}`, ...(frame.landmarks !== undefined ? { landmarks: frame.landmarks } : {}) })) }, 200) as never;
});
talkFramesRoutes.openapi(frameRoute, (c) => {
  const { job, index } = c.req.valid("param");
  const frame = takeTalkResult(job)?.frames[index];
  if (!frame) return reply(c, { error: "No such frame: it expired after ten minutes or was never made. Send the picture again.", code: "expired" }, 404) as never;
  return new Response(frame.png, { status: 200, headers: { "content-type": "image/png", "cache-control": "no-store" } }) as never;
});
