// MODELPACK-JOBS-01: the second door. A generic request is planned (`planMake`), its prompt is filled from the chosen pack's recipe and its size
// and part come from the pack, then it is handed to the existing runner's route in this process, so the same seed makes the same files as the
// old route. Only the jobs listed in WIRED_JOBS are served; the catalog never claims a job that is not wired (see jobsCatalog.ts).
import type { StackMakeRequest, StackMakeResult } from "@maipai/spec/stack/ts/stack-make.js";
import type { MakePlan } from "@/lib/makePlan";
import { fillRecipe } from "@/lib/recipe";

export const WIRED_JOBS: ReadonlySet<string> = new Set(["picture", "picture_edit", "clip"]);

type Forward = (path: string, body: unknown) => Promise<{ status: number; json: unknown }>;
type Planned = Extract<MakePlan, { ok: true }>;

export function pictureBody(request: Extract<StackMakeRequest, { job: "picture" }>, plan: Planned): Record<string, unknown> {
  const pixels = (plan.serving.job.limits.shapes as Record<string, Record<string, { width: number; height: number } | undefined> | undefined> | undefined)?.[request.shape]?.[plan.level];
  const recipe = plan.serving.pack.recipes[plan.serving.job.recipe] ?? "{description}";
  return {
    model: plan.serving.part.id, prompt: fillRecipe(recipe, { description: request.description, words: request.words }),
    ...(pixels ? { size: `${pixels.width}x${pixels.height}` } : {}), ...(request.count ? { n: request.count } : {}), ...(request.seed !== undefined ? { seed: request.seed } : {}),
    audience: request.audience === "adult" ? "adult" : "all-ages",
  };
}

export async function dispatchPicture(request: Extract<StackMakeRequest, { job: "picture" }>, plan: Planned, forward: Forward): Promise<{ status: number; body: unknown }> {
  const sent = await forward("/v1/images/generations", pictureBody(request, plan));
  if (sent.status !== 200 && sent.status !== 202) return { status: sent.status, body: sent.json };
  const reply = sent.json as { job: string; data?: Array<{ url: string }>; notes?: string[] };
  const done = (reply.data?.length ?? 0) > 0;
  const result: StackMakeResult = {
    id: reply.job, job: "picture", state: done ? "done" : "running", percent: done ? 100 : 0, status: done ? "Done" : "Making your picture",
    files: (reply.data ?? []).map((d) => d.url), poster: reply.data?.[0]?.url ?? null,
    made_with: { part: plan.serving.part.id, label: plan.serving.part.label, pack_version: plan.serving.pack.pack.version, shape: request.shape, seconds: null, sound: false, notes: reply.notes ?? [] },
  };
  return { status: sent.status, body: result };
}

type ClipRequest = Extract<StackMakeRequest, { job: "clip" }>;
/** A picture named in a request is a file this Stack already served (a path under /v1/) or a data: URL. Anything else cannot be read here and is refused plainly. */
export const PICTURE_UNREADABLE_LINE = "That picture could not be found. Send the picture a job just made, or a data: URL of it.";
export type PictureBytes = (reference: string) => Promise<{ bytes: Uint8Array; type: string } | null>;
export type FormForward = (path: string, form: FormData) => Promise<{ status: number; json: unknown }>;
type EditRequest = Extract<StackMakeRequest, { job: "picture_edit" }>;

export function editFields(request: EditRequest, plan: Planned): Record<string, string> {
  const recipe = plan.serving.pack.recipes[plan.serving.job.recipe] ?? "{description}";
  return { model: plan.serving.part.id, operation: request.mask ? "edit_masked" : "edit", instruction: fillRecipe(recipe, { description: request.description, words: request.words }), image_source: "uploaded", audience: request.audience === "adult" ? "adult" : "all-ages" };
}

export async function dispatchPictureEdit(request: EditRequest, plan: Planned, read: PictureBytes, forward: FormForward): Promise<{ status: number; body: unknown }> {
  const main = await read(request.picture);
  if (!main) return { status: 409, body: { code: "not_available", line: PICTURE_UNREADABLE_LINE } };
  const form = new FormData();
  for (const [key, value] of Object.entries(editFields(request, plan))) form.set(key, value);
  form.set("image", new File([main.bytes as unknown as ArrayBuffer], "picture", { type: main.type }));
  if (request.mask) {
    const mask = await read(request.mask);
    if (!mask) return { status: 409, body: { code: "not_available", line: PICTURE_UNREADABLE_LINE } };
    form.set("mask", new File([mask.bytes as unknown as ArrayBuffer], "mask", { type: mask.type }));
  }
  let n = 0;
  for (const reference of request.references ?? []) {
    const got = await read(reference);
    if (!got) return { status: 409, body: { code: "not_available", line: PICTURE_UNREADABLE_LINE } };
    n += 1;
    const field = n === 1 ? "reference" : `reference${n}`;
    form.set(field, new File([got.bytes as unknown as ArrayBuffer], field, { type: got.type }));
    form.set(`${field}_source`, "uploaded");
  }
  const sent = await forward("/v1/images/edits", form);
  if (sent.status !== 200 && sent.status !== 202) return { status: sent.status, body: sent.json };
  const reply = sent.json as { job?: string; data?: unknown[]; notes?: string[] };
  const done = (reply.data?.length ?? 0) > 0;
  const id = reply.job ?? "";
  const result: StackMakeResult = {
    id, job: "picture_edit", state: done ? "done" : "running", percent: done ? 100 : 0, status: done ? "Done" : "Changing your picture",
    files: done && id ? [`/v1/images/edits/${id}`] : [], poster: done && id ? `/v1/images/edits/${id}` : null,
    made_with: { part: plan.serving.part.id, label: plan.serving.part.label, pack_version: plan.serving.pack.pack.version, shape: null, seconds: null, sound: false, notes: reply.notes ?? [] },
  };
  return { status: sent.status, body: result };
}

export async function pictureDataUrl(reference: string, read: PictureBytes): Promise<string | null> {
  const got = await read(reference);
  return got ? `data:${got.type};base64,${Buffer.from(got.bytes).toString("base64")}` : null;
}

export function clipBody(request: ClipRequest, plan: Planned): Record<string, unknown> {
  const pixels = (plan.serving.job.limits.shapes as Record<string, Record<string, { width: number; height: number } | undefined> | undefined> | undefined)?.[request.shape]?.[plan.level];
  const recipe = plan.serving.pack.recipes[plan.serving.job.recipe] ?? "{description}";
  return {
    model: plan.serving.part.id, prompt: fillRecipe(recipe, { description: request.description }),
    ...(pixels ? { size: `${pixels.width}x${pixels.height}` } : {}), seconds: Math.round(request.seconds), ...(request.seed !== undefined ? { seed: request.seed } : {}),
    audience: request.audience === "adult" ? "adult" : "all-ages",
  };
}

export async function dispatchClip(request: ClipRequest, plan: Planned, forward: Forward, read?: PictureBytes): Promise<{ status: number; body: unknown }> {
  const body = clipBody(request, plan);
  if (request.start_picture || request.end_picture) {
    const first = request.start_picture && read ? await pictureDataUrl(request.start_picture, read) : null;
    const last = request.end_picture && read ? await pictureDataUrl(request.end_picture, read) : null;
    if ((request.start_picture && !first) || (request.end_picture && !last)) return { status: 409, body: { code: "not_available", line: PICTURE_UNREADABLE_LINE } };
    if (first) body.image = first;
    if (last) body.end_image = last;
  }
  const sent = await forward("/v1/videos/generations", body);
  if (sent.status !== 200 && sent.status !== 202) return { status: sent.status, body: sent.json };
  const reply = sent.json as { job: string; data?: Array<{ url: string; poster_url?: string; seconds?: number; audio?: boolean }>; notes?: string[] };
  const first = reply.data?.[0];
  const result: StackMakeResult = {
    id: reply.job, job: "clip", state: first ? "done" : "running", percent: first ? 100 : 0, status: first ? "Done" : "Making your clip",
    files: (reply.data ?? []).map((d) => d.url), poster: first?.poster_url ?? null,
    made_with: { part: plan.serving.part.id, label: plan.serving.part.label, pack_version: plan.serving.pack.pack.version, shape: request.shape, seconds: first?.seconds ?? request.seconds, sound: first?.audio ?? plan.serving.job.capabilities.sound, notes: reply.notes ?? [] },
  };
  return { status: sent.status, body: result };
}
