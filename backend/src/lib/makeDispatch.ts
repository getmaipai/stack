// MODELPACK-JOBS-01: the second door. A generic request is planned (`planMake`), its prompt is filled from the chosen pack's recipe and its size
// and part come from the pack, then it is handed to the existing runner's route in this process, so the same seed makes the same files as the
// old route. Only the jobs listed in WIRED_JOBS are served; the catalog never claims a job that is not wired (see jobsCatalog.ts).
import type { StackMakeRequest, StackMakeResult } from "@maipai/spec/stack/ts/stack-make.js";
import type { MakePlan } from "@/lib/makePlan";
import { fillRecipe } from "@/lib/recipe";

export const WIRED_JOBS: ReadonlySet<string> = new Set(["picture"]);

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
