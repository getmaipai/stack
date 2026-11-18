// MODELPACK-JOBS-01: the jobs catalog, "what can be made here, now". A view over the packs, the parts list (state, fit, the household's
// order) and nothing else: it starts nothing, reads no model name, and adds no second readiness read. The audience gate is part of the
// view: a minor's catalog lists only the jobs some part in the minor's list serves, with neutral labels, and carries no reason and no
// alternative (rule C10); a minor's candidates are ordered by the shipped priority and never by the household's order (rule E6).
import { StackJobsCatalog, type StackJobsCatalog as Catalog } from "@maipai/spec/stack/ts/stack-jobs-catalog.js";
import type { StackJobName } from "@maipai/spec/stack/ts/stack-model-pack.js";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import { packs, type LoadedPack } from "@/packs/loader";
import { listParts, type PartsAudience } from "@/lib/partsList";
import { PART_DEFS } from "@/lib/partDefs";
import type { HardwareInfo } from "@/lib/hardware";
import { WIRED_JOBS } from "@/lib/makeDispatch";

type Level = "standard" | "boost" | "max";
type PackJob = LoadedPack["pack"]["jobs"][number];

/** The eight generic jobs, in the order a page lists them, with the plain name a person sees. */
export const JOB_LABELS: Readonly<Record<StackJobName, string>> = {
  picture: "Make a picture", picture_edit: "Change a picture", clip: "Make a video clip", clip_from_sheet: "Make a clip from a character sheet",
  restyle: "Restyle a clip", swap: "Swap a face in a clip", character_sheet: "Make a character sheet", contact_sheet: "Make a contact sheet",
  song: "Make a song", song_edit: "Change a song", sound_effect: "Make a sound effect", stems: "Split a song into parts", vocal_swap: "Swap a singing voice", lyric_timing: "Time the lyrics to a song",
};
const JOB_ORDER = Object.keys(JOB_LABELS) as StackJobName[];
/** The lowercase phrase inside the "nothing can do this" sentence. */
export const JOB_PHRASE: Readonly<Record<StackJobName, string>> = {
  picture: "make pictures", picture_edit: "change pictures", clip: "make video clips", clip_from_sheet: "make a clip from a sheet",
  restyle: "restyle a clip", swap: "swap a face in a clip", character_sheet: "make a character sheet", contact_sheet: "make a contact sheet",
  song: "make songs", song_edit: "change songs", sound_effect: "make sound effects", stems: "split songs into parts", vocal_swap: "swap a singing voice", lyric_timing: "time lyrics to a song",
};

const levelsOf = (job: PackJob): Level[] => {
  const found = new Set<Level>();
  for (const shape of Object.values(job.limits.shapes ?? {})) for (const level of Object.keys(shape ?? {})) found.add(level as Level);
  for (const level of Object.keys(job.limits.max_seconds ?? {})) found.add(level as Level);
  const order: Level[] = ["standard", "boost", "max"];
  const levels = order.filter((l) => found.has(l));
  return levels.length ? levels : ["standard"];
};
const runnable = (part: StackPartView): boolean => part.enabled && part.state === "ready" && (part.fits.standard || part.fits.boost || part.fits.max);

export interface Serving { pack: LoadedPack; job: PackJob; part: StackPartView }
/** The parts that serve a job for an audience, in the order a job would pick them: the household's order for an adult, the shipped priority for a minor (rule E6). */
export function servingFor(name: StackJobName, audience: PartsAudience, parts: readonly StackPartView[]): Serving[] {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const shipped = new Map(PART_DEFS.map((d) => [d.id, d.priority]));
  const rank = (id: string) => (audience === "minor" ? (shipped.get(id) ?? 999) : (byId.get(id)?.priority ?? 999));
  return packs().flatMap((p) => {
    const job = p.pack.jobs.find((j) => j.job === name && j.audiences.includes(audience));
    const part = byId.get(p.pack.part);
    return job && part ? [{ pack: p, job, part }] : [];
  }).sort((a, b) => rank(a.part.id) - rank(b.part.id) || a.part.id.localeCompare(b.part.id));
}
export const isRunnable = runnable;

export async function jobsCatalog(audience: PartsAudience, hw?: HardwareInfo): Promise<Catalog> {
  const list = await listParts({ audience, kind: "model" }, hw);

  const jobs = JOB_ORDER.flatMap((name) => {
    const serving = servingFor(name, audience, list.parts);
    if (!serving.length && audience === "minor") return []; // a job a minor may not have is absent, never explained
    const chosen = WIRED_JOBS.has(name) ? (serving.find((s) => runnable(s.part)) ?? null) : null; // a job not wired through the generic door is never "available"
    const shown = chosen ?? serving[0] ?? null;
    const limitsSource = shown?.job;
    const entry = {
      job: name, label: JOB_LABELS[name], available: chosen !== null,
      part: chosen ? { id: chosen.part.id, label: chosen.part.label } : null,
      limits: limitsSource ? { levels: levelsOf(limitsSource), ...(limitsSource.limits.max_seconds ? { max_seconds: limitsSource.limits.max_seconds } : {}), ...(limitsSource.limits.max_references !== undefined ? { max_references: limitsSource.limits.max_references } : {}), ...(limitsSource.limits.shapes ? { shapes: limitsSource.limits.shapes } : {}), ...(limitsSource.limits.max_words !== undefined ? { max_words: limitsSource.limits.max_words } : {}) } : { levels: ["standard" as Level] },
      capabilities: limitsSource?.capabilities ?? { text: false, end_picture: false, sound: false, keeps_likeness: false },
      styles: { bases: shown?.pack.pack.style_bases?.filter((b) => !b.retired).map((b) => ({ id: b.id, label: b.label })) ?? [], max: 0 },
      restyles: [] as Array<{ name: string; label: string }>,
    };
    if (audience === "minor") return [entry];
    const why = chosen ? null : serving.length && !WIRED_JOBS.has(name) ? `This kind of job is not available through the generic door yet. An admin does not need to do anything.` : serving.length
      ? `No model that can ${JOB_PHRASE[name]} is turned on and ready. An admin can turn one on or add one in Settings, AI and models.`
      : `No model that can ${JOB_PHRASE[name]} is installed here. An admin can add one in Settings, AI and models.`;
    return [{ ...entry, why_not: why, alternatives: serving.filter((s) => s !== chosen).map((s) => ({ part: s.part.id, label: s.part.label })) }];
  });
  const parsed = StackJobsCatalog.safeParse({ audience, jobs });
  if (!parsed.success) throw new Error(`The jobs catalog does not match the spec: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}
