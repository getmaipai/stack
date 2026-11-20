// MODELPACK-JOBS-01: which part serves one generic request, and whether its inputs fit. Pure over the parts list and the packs: it
// starts nothing. The refusals are the spec's (`StackMakeRefusal`), each one line a person can act on, in the Stack's words, and a
// minor's refusal names no model (rule C10). Nothing here reads a model's name; a pack's numbers and a part's label do the work.
import type { StackMakeRequest, StackMakeRefusal } from "@maipai/spec/stack/ts/stack-make.js";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import { parseMinorRecipe } from "@/lib/recipe";
import { JOB_PHRASE, isRunnable, servingFor, type Serving } from "@/lib/jobsCatalog";

export type MakePlan =
  | { ok: true; serving: Serving; level: "standard" | "boost" | "max"; shape: "landscape" | "portrait" | "square" | null; seconds: number | null; minorRecipe?: { id: string; version: string } }
  | { ok: false; refusal: StackMakeRefusal }
  | { ok: false; unavailable: string };

/** The longest idea a minor may send for a clip (characters). */
export const MINOR_DESCRIPTION_MAX = 400;
const SHAPES = ["landscape", "portrait", "square"] as const;

/** The levels one pack job serves; a job whose limits name none serves Standard only. */
const levelsServedBy = (limits: Serving["job"]["limits"]): Set<string> => {
  const found = new Set<string>([...Object.keys(limits.max_seconds ?? {}), ...Object.values(limits.shapes ?? {}).flatMap((s) => Object.keys(s ?? {}))]);
  return found.size ? found : new Set(["standard"]);
};

export function planMake(request: StackMakeRequest, parts: readonly StackPartView[]): MakePlan {
  const audience = request.audience;
  const minorRefusal: MakePlan = { ok: false, refusal: { code: "not_on_this_model", line: "That is not available right now.", alternatives: [] } };
  if (audience === "minor" && request.job === "clip") {
    const refuse = (code: "input_not_supported" | "not_on_this_model" = "input_not_supported"): MakePlan => ({ ok: false, refusal: { code, line: "That is not available right now.", alternatives: [] } });
    // An allow-list: a minor's clip carries only these keys, so a field added to the clip request later is refused until it is deliberately allowed here.
    const allowed = new Set(["job", "audience", "rating", "description", "shape", "level", "seconds", "seed", "part", "loop"]);
    if (Object.keys(request).some((key) => !allowed.has(key) && (request as Record<string, unknown>)[key] !== undefined)) return refuse();
    if (request.rating !== "G" && request.rating !== "PG-13") return refuse();
    if (request.level !== "standard") return refuse();
    // The fixed wording must stay inside the engine's prompt: a longer idea is refused plainly, never trimmed.
    if (request.description.length > MINOR_DESCRIPTION_MAX) return refuse();
    if (request.operation === "companion_take") return refuse();
    if (!servingFor("clip", "minor", parts).some((s) => isRunnable(s.part) && !!s.job.minor_recipes?.[request.rating as "G" | "PG-13"])) return minorRefusal;
  }
  const all = servingFor(request.job, audience, parts);
  const wantsWords = (request.job === "picture" || request.job === "picture_edit") && !!request.words;
  const fit = wantsWords ? all.filter((s) => s.job.capabilities.text) : all;

  let chosen: Serving | undefined;
  if (request.part) {
    chosen = all.find((s) => s.part.id === request.part);
    if (!chosen || (wantsWords && !chosen.job.capabilities.text) || !isRunnable(chosen.part)) {
      // A minor's refusal names no model and offers none (rule C10). An adult is told what the model cannot do and what can.
      if (audience === "minor") return { ok: false, refusal: { code: "not_on_this_model", line: "That is not available right now.", alternatives: [] } };
      const label = parts.find((p) => p.id === request.part)?.label ?? "That model";
      const others = fit.filter((s) => s.part.id !== request.part && isRunnable(s.part));
      const cannot = !chosen ? `cannot ${JOB_PHRASE[request.job]}` : wantsWords && !chosen.job.capabilities.text ? "cannot spell words in a picture" : "is not turned on and ready";
      return { ok: false, refusal: { code: "not_on_this_model", line: others.length ? `${label} ${cannot}. Home can use ${others[0]!.part.label} instead.` : `${label} ${cannot}, and nothing else here can do this either.`, alternatives: others.map((s) => ({ part: s.part.id, label: s.part.label })) } };
    }
  } else {
    // A request that names a level is planned among the parts whose pack serves it (the song parts split the levels between them). When some
    // pack serves it but no such part is turned on and ready (though another part is), the reason says the level is what is missing; when no pack serves it, the first
    // ready part is chosen and refuses it below with `level_not_served`.
    const asked = "level" in request ? request.level : undefined;
    const servesAsked = asked ? fit.filter((s) => levelsServedBy(s.job.limits).has(asked)) : [];
    if (asked && servesAsked.length && !servesAsked.some((s) => isRunnable(s.part)) && fit.some((s) => isRunnable(s.part))) {
      return { ok: false, unavailable: `No model that can ${JOB_PHRASE[request.job]} at ${asked} quality is turned on and ready.${audience === "minor" ? "" : " An admin can turn one on or add one in Settings, AI and models."}` };
    }
    chosen = (servesAsked.length ? servesAsked : fit).find((s) => isRunnable(s.part));
    if (!chosen) return { ok: false, unavailable: wantsWords ? "No model that can spell words in a picture is turned on and ready." : `No model that can ${JOB_PHRASE[request.job]} is turned on and ready.` };
  }

  let minorRecipe: { id: string; version: string } | undefined;
  if (audience === "minor" && request.job === "clip") {
    const rating = request.rating as "G" | "PG-13";
    const path = chosen.job.minor_recipes?.[rating];
    const recipeText = path ? chosen.pack.recipes[path] : undefined;
    if (!recipeText) return { ok: false, refusal: { code: "not_on_this_model", line: "That is not available right now.", alternatives: [] } };
    try { const parsed = parseMinorRecipe(recipeText); minorRecipe = { id: parsed.id, version: parsed.version }; } catch { return minorRefusal; }
  }

  const limits = chosen.job.limits;
  const levelsServed = new Set<string>([...Object.keys(limits.max_seconds ?? {}), ...Object.values(limits.shapes ?? {}).flatMap((s) => Object.keys(s ?? {}))]);
  // A request that names no level (a song may leave it out) gets Standard where the model serves it, else the first level it does serve.
  const asked = "level" in request ? request.level : undefined;
  const level = (asked ?? (levelsServed.size === 0 || levelsServed.has("standard") ? "standard" : [...levelsServed][0]!)) as "standard" | "boost" | "max";
  if (levelsServed.size && !levelsServed.has(level)) return { ok: false, refusal: { code: "level_not_served", line: `This model does not make ${level} quality. Choose ${[...levelsServed].join(" or ")}.` } };
  const shape = "shape" in request ? request.shape : null;
  // An identity first picture takes its shape from the likeness-keeping edit job's `first_picture_shapes`, which the identity dispatch checks (and refuses plainly); the ordinary shape list does not apply to it.
  const identityFirstPicture = request.job === "picture" && (request.inputs ?? []).some((input) => input.role === "identity");
  if (shape && !identityFirstPicture && limits.shapes && !SHAPES.some((name) => name === shape && (limits.shapes as Record<string, Record<string, unknown> | undefined>)[name]?.[level])) return { ok: false, refusal: { code: "shape_not_served", line: `This model does not make ${shape} pictures at ${level} quality. Choose ${SHAPES.filter((n) => (limits.shapes as Record<string, Record<string, unknown> | undefined>)[n]?.[level]).join(" or ") || "another quality"}.` } };
  const seconds = "seconds" in request ? request.seconds : null;
  const maxSeconds = (limits.max_seconds as Record<string, number> | undefined)?.[level];
  if (seconds !== null && maxSeconds !== undefined && seconds > maxSeconds) return { ok: false, refusal: { code: "too_long", line: `This model makes ${request.job === "song" || request.job === "song_edit" ? "songs" : "clips"} up to ${maxSeconds} seconds at ${level} quality. Choose a shorter one.`, limit: maxSeconds } };
  const references = "references" in request && request.references ? request.references.length : 0;
  if (limits.max_references !== undefined && references > limits.max_references) return { ok: false, refusal: { code: "too_many_references", line: `This model takes up to ${limits.max_references} reference pictures. Use fewer.`, limit: limits.max_references } };
  return { ok: true, serving: chosen, level, shape, seconds, ...(minorRecipe ? { minorRecipe } : {}) };
}
