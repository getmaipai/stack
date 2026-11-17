// MODELPACK-JOBS-01: which part serves one generic request, and whether its inputs fit. Pure over the parts list and the packs: it
// starts nothing. The refusals are the spec's (`StackMakeRefusal`), each one line a person can act on, in the Stack's words, and a
// minor's refusal names no model (rule C10). Nothing here reads a model's name; a pack's numbers and a part's label do the work.
import type { StackMakeRequest, StackMakeRefusal } from "@maipai/spec/stack/ts/stack-make.js";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import { JOB_PHRASE, isRunnable, servingFor, type Serving } from "@/lib/jobsCatalog";

export type MakePlan =
  | { ok: true; serving: Serving; level: "standard" | "boost" | "max"; shape: "landscape" | "portrait" | "square" | null; seconds: number | null }
  | { ok: false; refusal: StackMakeRefusal }
  | { ok: false; unavailable: string };

const SHAPES = ["landscape", "portrait", "square"] as const;

export function planMake(request: StackMakeRequest, parts: readonly StackPartView[]): MakePlan {
  const audience = request.audience;
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
    chosen = fit.find((s) => isRunnable(s.part));
    if (!chosen) return { ok: false, unavailable: wantsWords ? "No model that can spell words in a picture is turned on and ready." : `No model that can ${JOB_PHRASE[request.job]} is turned on and ready.` };
  }

  const limits = chosen.job.limits;
  const level = "level" in request ? request.level : "standard";
  const levelsServed = new Set<string>([...Object.keys(limits.max_seconds ?? {}), ...Object.values(limits.shapes ?? {}).flatMap((s) => Object.keys(s ?? {}))]);
  if (levelsServed.size && !levelsServed.has(level)) return { ok: false, refusal: { code: "level_not_served", line: `This model does not make ${level} quality. Choose ${[...levelsServed].join(" or ")}.` } };
  const shape = "shape" in request ? request.shape : null;
  if (shape && limits.shapes && !SHAPES.some((name) => name === shape && (limits.shapes as Record<string, Record<string, unknown> | undefined>)[name]?.[level])) return { ok: false, refusal: { code: "shape_not_served", line: `This model does not make ${shape} pictures at ${level} quality. Choose ${SHAPES.filter((n) => (limits.shapes as Record<string, Record<string, unknown> | undefined>)[n]?.[level]).join(" or ") || "another quality"}.` } };
  const seconds = "seconds" in request ? request.seconds : null;
  const maxSeconds = (limits.max_seconds as Record<string, number> | undefined)?.[level];
  if (seconds !== null && maxSeconds !== undefined && seconds > maxSeconds) return { ok: false, refusal: { code: "too_long", line: `This model makes clips up to ${maxSeconds} seconds at ${level} quality. Choose a shorter clip.`, limit: maxSeconds } };
  const references = "references" in request && request.references ? request.references.length : 0;
  if (limits.max_references !== undefined && references > limits.max_references) return { ok: false, refusal: { code: "too_many_references", line: `This model takes up to ${limits.max_references} reference pictures. Use fewer.`, limit: limits.max_references } };
  return { ok: true, serving: chosen, level, shape, seconds };
}
