import { dispatchIdentityPicture, hasIdentityInput } from "@/lib/makeDispatchIdentity";
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import { StackMakeRequest, StackMakeResult, StackMakeRefusal } from "@maipai/spec/stack/ts/stack-make.js";
import type { AppEnv } from "@/types";
import { listParts } from "@/lib/partsList";
import { dispatchSong, dispatchSongEdit, dispatchStems } from "@/lib/makeDispatchAudio";
import { dispatchSwap } from "@/lib/makeDispatchSwap";
import { dispatchCharacterSheet, dispatchContactSheet } from "@/lib/makeDispatchSheets";
import { planMake } from "@/lib/makePlan";
import { WIRED_JOBS, dispatchClip, dispatchPicture, dispatchPictureEdit, type PictureBytes } from "@/lib/makeDispatch";

const NotAvailable = z.object({ code: z.literal("not_available"), line: z.string().min(1) }).strict();
const route = createRoute({
  method: "post", path: "/", tags: ["Jobs"], summary: "Make one thing with a generic job (MODELPACK-JOBS-01): picture, clip, song, stems and sheets",
  description: "A second door to the existing runners. The request names a job and its inputs and may name a `part` only by an id this Stack gave it. The Stack picks the part (the named one if it serves the job and is ready, else the first ready one in the audience's order), checks the inputs against the model's pack, fills the pack's recipe, and hands the work to the same runner the old route uses, so the same seed makes the same files. Refusals are `StackMakeRefusal`: `not_on_this_model` (the line says what can do it; a minor's names no model), `too_many_references`, `too_long`, `shape_not_served`, `level_not_served`. `not_available` means no part that can do it is turned on and ready, or the job is not wired through this door yet (`GET /stack/v1/jobs/catalog` says which).",
  request: { body: { required: true, content: { "application/json": { schema: StackMakeRequest } } } },
  responses: {
    200: { content: { "application/json": { schema: StackMakeResult } }, description: "The picture is ready." },
    202: { content: { "application/json": { schema: StackMakeResult } }, description: "Still going; poll the job." },
    409: { content: { "application/json": { schema: z.union([StackMakeRefusal, NotAvailable]) } }, description: "Refused, with one plain line." },
  },
});
export const jobsMakeRoutes = apiRouter<AppEnv>();
jobsMakeRoutes.openapi(route, async (c) => {
  const request = c.req.valid("json");
  const parts = (await listParts({ audience: request.audience, kind: "model" })).parts;
  const plan = planMake(request, parts);
  if (!plan.ok) {
    if ("refusal" in plan) return c.json(plan.refusal, 409) as never;
    return c.json({ code: "not_available", line: plan.unavailable }, 409) as never;
  }
  if (!WIRED_JOBS.has(request.job)) return c.json({ code: "not_available", line: "This kind of job is not available through this door yet." }, 409) as never;
  const { app } = await import("@/app");
  const forward = async (path: string, body: unknown) => {
    const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const read: PictureBytes = async (reference) => {
    if (reference.startsWith("data:")) {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(reference);
      return match ? { bytes: new Uint8Array(Buffer.from(match[2]!, "base64")), type: match[1]! } : null;
    }
    if (!reference.startsWith("/v1/") || reference.includes("..")) return null;
    const response = await app.request(reference);
    return response.status === 200 ? { bytes: new Uint8Array(await response.arrayBuffer()), type: response.headers.get("content-type") ?? "image/png" } : null;
  };
  const forwardForm = async (path: string, form: FormData) => {
    const response = await app.request(path, { method: "POST", body: form });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  if (hasIdentityInput(request)) { const identityResult = await dispatchIdentityPicture(request, parts, read, forwardForm); return c.json(identityResult.body as never, identityResult.status as 200) as never; }
  const result = request.job === "swap" ? await dispatchSwap(request, plan, read, c) : request.job === "song" ? await dispatchSong(request, plan, forward) : request.job === "song_edit" ? await dispatchSongEdit(request, plan, read, forward) : request.job === "stems" ? await dispatchStems(request, plan, read, forward) : request.job === "clip" ? await dispatchClip(request, plan, forward, read) : request.job === "picture_edit" ? await dispatchPictureEdit(request, plan, read, forwardForm) : request.job === "character_sheet" ? await dispatchCharacterSheet(request, plan, read, forwardForm) : request.job === "contact_sheet" ? await dispatchContactSheet(request, plan, read, forwardForm) : await dispatchPicture(request as never, plan, forward);
  return c.json(result.body as never, result.status as 200) as never;
});
