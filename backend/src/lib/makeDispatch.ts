// MODELPACK-JOBS-01: the second door. A generic request is planned (`planMake`), its prompt is filled from the chosen pack's recipe and its size
// and part come from the pack, then it is handed to the existing runner's route in this process, so the same seed makes the same files as the
// old route. Only the jobs listed in WIRED_JOBS are served; the catalog never claims a job that is not wired (see jobsCatalog.ts).
import { sha256Hex } from "@/video/receipt";
import type { StackMakeRequest, StackMakeResult } from "@maipai/spec/stack/ts/stack-make.js";
import type { MakePlan } from "@/lib/makePlan";
import { fillRecipe, fillStyleRecipe } from "@/lib/recipe";
import { writePrompt, writerData } from "@/video/promptWriter";
import { planClipRoute } from "@/lib/clipRoute";
import { engineOfPart, rowsForJob } from "@/video/caps";
import { videoRecipe } from "@/video/recipes";
import { tierRoomBytes } from "@/lib/governor";
import { resolveReadable } from "@/media/paths";
import { videoPath, readResult, readTake } from "@/video/results";
import { packFor } from "@/packs/loader";
import { existsSync } from "node:fs";
import { getLora, loraPath, LORA_BASE_LTX25 } from "@/video/loras";
import { isLoraId } from "@/video/loras";
import { statSync } from "node:fs";
import { sha256OfFile } from "@/lib/fileHash";

export const WIRED_JOBS: ReadonlySet<string> = new Set(["picture", "picture_edit", "clip", "swap", "song", "song_edit", "stems", "character_sheet", "contact_sheet"]);

type Forward = (path: string, body: unknown) => Promise<{ status: number; json: unknown }>;
type Planned = Extract<MakePlan, { ok: true }>;

/** The request's `styles` (library ids of the household's style files) as the old routes' `loras`; the route checks the file fits the part. */
const stylesAsLoras = (styles: string[] | undefined): Record<string, unknown> => (styles?.length ? { loras: styles.map((id) => ({ id })) } : {});

/** The request's `wait` (whole seconds) as the old route's `timeout_ms`. Zero is the shortest wait the route takes, so the answer is 202 with the job id. */
export function withWait(body: Record<string, unknown>, wait: number | undefined): Record<string, unknown> {
  return wait === undefined ? body : { ...body, timeout_ms: Math.max(1, wait * 1000) };
}

export function pictureBody(request: Extract<StackMakeRequest, { job: "picture" }>, plan: Planned): Record<string, unknown> {
  const pixels = (plan.serving.job.limits.shapes as Record<string, Record<string, { width: number; height: number } | undefined> | undefined> | undefined)?.[request.shape]?.[plan.level];
  const recipe = plan.serving.pack.recipes[plan.serving.job.recipe] ?? "{description}";
  return {
    model: plan.serving.part.id, prompt: fillRecipe(recipe, { description: request.description, words: request.words }),
    ...(pixels ? { size: `${pixels.width}x${pixels.height}` } : {}), ...(request.count ? { n: request.count } : {}), ...(request.seed !== undefined ? { seed: request.seed } : {}),
    audience: request.audience === "adult" ? "adult" : "all-ages", ...stylesAsLoras(request.styles),
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
export const INPUT_UNREADABLE_LINE = "A file named in the request could not be found. Send a file this Stack just made, or a data: URL of it.";
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

export function clipBody(request: ClipRequest, plan: Planned, route?: { name: string; reason: string }): Record<string, unknown> {
  const pixels = (plan.serving.job.limits.shapes as Record<string, Record<string, { width: number; height: number } | undefined> | undefined> | undefined)?.[request.shape]?.[plan.level];
  const recipe = plan.serving.pack.recipes[plan.serving.job.recipe] ?? "{description}";
  // VF-PROMPT-01: a pack whose clip recipe declares a prompt writer gets the prompt in its engine's own format, written from the typed request (the person's
  // words, structured dialogue, pictures, the film's look); a pack without one keeps the plain recipe. The writer and its hints go to the receipt, never the text.
  const data = writerData(recipe);
  const written = data ? writePrompt({ description: request.description, ...(request.dialogue ? { dialogue: request.dialogue } : {}), seconds: request.seconds, startPicture: request.start_picture !== undefined, endPicture: request.end_picture !== undefined, ...(request.look !== undefined ? { look: request.look } : {}) }, data) : null;
  return {
    model: plan.serving.part.id, prompt: written ? written.text : fillRecipe(recipe, { description: request.description }),
    ...(written ? { prompt_writer: written.writer, prompt_hints: written.hints } : {}),
    ...(pixels ? { size: `${pixels.width}x${pixels.height}` } : {}), seconds: Math.round(request.seconds), ...(request.seed !== undefined ? { seed: request.seed } : {}),
    audience: request.audience === "adult" ? "adult" : "all-ages", ...stylesAsLoras(request.styles),
    // VF-DOOR-01: the level is the job's tier, so a Boost or Max clip is admitted, governed and classed as one (a Standard clip keeps the untiered admission, as on the
    // old door); the household's quiet window passes through; a caller that will not wait (`wait` 0) gets the job id at once.
    level: plan.level,
    ...(plan.level === "boost" || plan.level === "max" ? { tier: plan.level } : {}),
    ...(request.quiet_seconds !== undefined ? { quiet_seconds: request.quiet_seconds } : {}),
    ...(request.quiet_max_wait_seconds !== undefined ? { quiet_max_wait_seconds: request.quiet_max_wait_seconds } : {}),
    ...(request.wait !== undefined ? { timeout_ms: Math.max(1, request.wait * 1000) } : {}),
    ...(request.take_of ? { take_of: request.take_of } : {}),
    ...(route ? { route } : {}),
  };
}

export async function dispatchClip(request: ClipRequest, plan: Planned, forward: Forward, read?: PictureBytes): Promise<{ status: number; body: unknown }> {
  const chosen = planClipRoute(request, rowsForJob(plan.serving.part.id, "clip").filter((row) => row.level === plan.level || row.operation === "clip_film_shot"));
  if (!chosen.ok) return { status: 422, body: chosen.refusal };
  const savedTake = request.take_of ? readTake(request.take_of) : null;
  // VF-ROUTE-01 follow-up: a film shot is made at the best Max recipe this computer can hold (full HD when admitted), chosen here from the operation and the machine, never from a size field.
  let filmSize: string | null = null; let filmReason = chosen.reason;
  if (chosen.filmShot) {
    const engine = engineOfPart(plan.serving.part.id);
    const hdRow = rowsForJob(plan.serving.part.id, "clip").find((row) => row.operation === "clip_film_shot" && row.available);
    const picked = engine ? videoRecipe(engine, "max", "clip_film_shot", undefined, tierRoomBytes("max")) : null;
    if (picked?.recipe.size && hdRow && request.seconds <= hdRow.seconds.max) { filmSize = `${picked.recipe.size.width}x${picked.recipe.size.height}`; filmReason = "A film shot, made in full HD because this computer can hold it."; }
    else if (!hdRow) filmReason = "A film shot, made at this home's usual size.";
    else filmReason = picked?.recipe.size ? `A film shot at the standard Max size: full HD makes at most ${hdRow?.seconds.max ?? 5} seconds.` : "A film shot at the standard Max size, because this computer cannot hold full HD right now.";
  }
  const route = request.operation === "retake_from" || request.operation === "extend" ? { name: request.operation, reason: chosen.reason } : { name: savedTake?.route ?? chosen.route, reason: savedTake ? "Another take from the saved clip route." : filmReason };
  if (request.operation === "retake_from" || request.operation === "extend") {
    const source = request.inputs?.find((input) => input.role === "edit_source")?.file;
    let sourcePath: string;
    try {
      const match = source?.match(/^\/v1\/videos\/generations\/([^/]+)\/video\.mp4$/);
      const job = match?.[1];
      if (job) {
        if (!readResult(job) || !existsSync(videoPath(job))) throw new Error("missing video result");
        sourcePath = videoPath(job);
      } else sourcePath = resolveReadable(source ?? "");
    } catch { return { status: 409, body: { code: "not_available", line: INPUT_UNREADABLE_LINE } }; }
    const recipe = plan.serving.pack.recipes[plan.serving.job.recipe] ?? "{description}";
    const body = { model: plan.serving.part.id, prompt: fillRecipe(recipe, { description: request.description }), source_video: sourcePath, ...(request.operation === "extend" ? { extend_seconds: request.seconds } : { retake_from_seconds: request.at_seconds }), level: plan.level, ...(request.seed !== undefined ? { seed: request.seed } : {}), audience: request.audience === "adult" ? "adult" : "all-ages", ...(request.wait !== undefined ? { timeout_ms: Math.max(1, request.wait * 1000) } : {}), route: { name: request.operation, reason: chosen.reason } };
    const sent = await forward("/v1/videos/generations", body);
    if (sent.status !== 200 && sent.status !== 202) return { status: sent.status, body: sent.json };
    const reply = sent.json as { job: string; data?: Array<{ url: string; poster_url?: string; seconds?: number; audio?: boolean }>; notes?: string[] };
    const first = reply.data?.[0];
    return { status: sent.status, body: { id: reply.job, job: "clip", state: first ? "done" : "running", percent: first ? 100 : 0, status: first ? "Done" : "Making your clip", files: (reply.data ?? []).map((d) => d.url), poster: first?.poster_url ?? null, made_with: { part: plan.serving.part.id, label: plan.serving.part.label, pack_version: plan.serving.pack.pack.version, shape: request.shape, seconds: first?.seconds ?? request.seconds, sound: first?.audio ?? plan.serving.job.capabilities.sound, notes: reply.notes ?? [], receipt: reply.job } } };
  }
  if (request.operation === "restyle") {
    const source = request.inputs?.find((input) => input.role === "edit_source")?.file;
    let sourcePath: string;
    try {
      const match = source?.match(/^\/v1\/videos\/generations\/([^/]+)\/video\.mp4$/);
      const job = match?.[1];
      if (job) {
        if (!readResult(job) || !existsSync(videoPath(job))) throw new Error("missing video result");
        sourcePath = videoPath(job);
      } else sourcePath = resolveReadable(source ?? "");
    } catch { return { status: 409, body: { code: "not_available", line: INPUT_UNREADABLE_LINE } }; }
    const styleId = request.styles?.[0];
    const record = styleId && isLoraId(styleId) ? getLora(styleId) : null;
    const styleFile = record ? loraPath(record.id) : "";
    if (!record || !existsSync(styleFile) || (record.base_model ?? "") !== LORA_BASE_LTX25) return { status: 409, body: { code: "not_available", line: "That style is not available. Choose an installed LTX-2.5 style." } };
    const stat = statSync(styleFile);
    if (stat.size !== record.bytes || (Math.floor(stat.mtimeMs) !== record.mtime_ms && await sha256OfFile(styleFile) !== record.sha256)) return { status: 409, body: { code: "not_available", line: "That style is not available. Choose an installed LTX-2.5 style." } };
    const recipe = plan.serving.pack.recipes["recipes/restyle.md"] ?? plan.serving.pack.recipes[plan.serving.job.recipe] ?? "{description}";
    const body = { source: sourcePath, lora: record.id, strength: request.style_strength ?? record.strength_default, conditioning: request.conditioning ?? "source", prompt: fillStyleRecipe(recipe, record.name, { description: request.description }), ...(request.seed !== undefined ? { seed: request.seed } : {}), ...(request.wait !== undefined ? { timeout_ms: Math.max(1, request.wait * 1000) } : {}), route: { name: "restyle", reason: chosen.reason } };
    const sent = await forward("/v1/videos/restyle", body);
    if (sent.status !== 200 && sent.status !== 202) return { status: sent.status, body: sent.json };
    const reply = sent.json as { job: string; data?: Array<{ url: string; poster_url?: string; seconds?: number; audio?: boolean }>; notes?: string[] };
    const done = (reply.data?.length ?? 0) > 0;
    return { status: sent.status, body: { id: reply.job, job: "clip", state: done ? "done" : "running", percent: done ? 100 : 0, status: done ? "Done" : "Restyling your clip", files: (reply.data ?? []).map((item) => item.url), poster: reply.data?.[0]?.poster_url ?? null, made_with: { part: plan.serving.part.id, label: plan.serving.part.label, pack_version: plan.serving.pack.pack.version, shape: request.shape, seconds: reply.data?.[0]?.seconds ?? 5, sound: reply.data?.[0]?.audio ?? true, notes: reply.notes ?? [], receipt: reply.job, route: "restyle", route_reason: chosen.reason } } };
  }
  let body: Record<string, unknown>;
  try { body = clipBody(request, plan, route); if (filmSize) body.size = filmSize; }
  catch (error) { return { status: 422, body: { code: "invalid_request", line: error instanceof Error ? error.message : "The clip's words could not be turned into a prompt. Describe what the clip shows and try again." } }; }
  if (request.start_picture || request.end_picture) {
    const first = request.start_picture && read ? await pictureDataUrl(request.start_picture, read) : null;
    const last = request.end_picture && read ? await pictureDataUrl(request.end_picture, read) : null;
    if ((request.start_picture && !first) || (request.end_picture && !last)) return { status: 409, body: { code: "not_available", line: PICTURE_UNREADABLE_LINE } };
    if (first) body.image = first;
    if (last) body.end_image = last;
  }
  let recipeChanged = false;
  if (savedTake && body.take_of) {
    const pack = packFor(plan.serving.part.id);
    const clipJob = pack?.pack.jobs.find((job) => job.job === "clip");
    const currentRecipe = clipJob?.profiles?.find((item) => item.level === savedTake.level);
    recipeChanged = savedTake.pack_version !== plan.serving.pack.pack.version || !savedTake.recipe || !clipJob?.profiles?.some((item) => item.level === savedTake.recipe!.level && item.steps === savedTake.recipe!.steps);
    body.take_facts = { part: plan.serving.part.id, pack_version: plan.serving.pack.pack.version, shape: savedTake.shape, operation: savedTake.operation };
    body.take_level = savedTake.level;
    if (recipeChanged && currentRecipe) body.take_recipe_steps = currentRecipe.steps;
  }
  // VF-ROLES-01: typed inputs are validated by the spec, read, and handed on as a role and a hash for the receipt; nothing acts on them yet.
  // `dialogue` and `intent` are accepted and ignored (the plain description is what the model is given). An input that cannot be read is refused, never dropped.
  if (request.inputs?.length) {
    const roles: Array<{ role: (typeof request.inputs)[number]["role"]; sha256: string; bytes: number }> = [];
    for (const input of request.inputs) {
      const got = read ? await read(input.file) : null;
      if (!got) return { status: 409, body: { code: "not_available", line: INPUT_UNREADABLE_LINE } };
      roles.push({ role: input.role, sha256: sha256Hex(got.bytes), bytes: got.bytes.length });
    }
    body.roles = roles;
  }
  const sent = await forward("/v1/videos/generations", body);
  if (sent.status !== 200 && sent.status !== 202) return { status: sent.status, body: sent.json };
  const reply = sent.json as { job: string; data?: Array<{ url: string; poster_url?: string; seconds?: number; audio?: boolean }>; notes?: string[] };
  const first = reply.data?.[0];
  const result: StackMakeResult = {
    id: reply.job, job: "clip", state: first ? "done" : "running", percent: first ? 100 : 0, status: first ? "Done" : "Making your clip",
    files: (reply.data ?? []).map((d) => d.url), poster: first?.poster_url ?? null,
    made_with: { part: plan.serving.part.id, label: plan.serving.part.label, pack_version: plan.serving.pack.pack.version, shape: request.shape, seconds: first?.seconds ?? request.seconds, sound: first?.audio ?? plan.serving.job.capabilities.sound, notes: reply.notes ?? [], receipt: reply.job, ...(chosen.operation === "retake" || chosen.operation === "extend" ? { route_reason: chosen.reason } : { route: chosen.route, route_reason: recipeChanged ? "The recipe was updated since the first take, so the current one was used." : chosen.reason }) },
  };
  return { status: sent.status, body: result };
}
