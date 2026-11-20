// MODELPACK-JOBS-01: the jobs catalog, "what can be made here, now". A view over the packs, the parts list (state, fit, the household's
// order) and nothing else: it starts nothing, reads no model name, and adds no second readiness read. The audience gate is part of the
// view: a minor's catalog lists only the jobs some part in the minor's list serves, with neutral labels, and carries no reason and no
// alternative (rule C10); a minor's candidates are ordered by the shipped priority and never by the household's order (rule E6).
import { StackJobsCatalog, type StackJobsCatalog as Catalog } from "@maipai/spec/stack/ts/stack-jobs-catalog.js";
import { StackMakeRequest } from "@maipai/spec/stack/ts/stack-make.js";
import specPackage from "@maipai/spec/package.json";
import type { StackJobName } from "@maipai/spec/stack/ts/stack-model-pack.js";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import { packs, type LoadedPack } from "@/packs/loader";
import { listParts, type PartsAudience } from "@/lib/partsList";
import { PART_DEFS } from "@/lib/partDefs";
import type { HardwareInfo } from "@/lib/hardware";
import { WIRED_JOBS } from "@/lib/makeDispatch";
import { jobCapabilitiesFromRows, jobLimitsFromRows, rowsForJob } from "@/video/caps";
import { ltx25MaxEditSupported } from "@/video/ltx25Edit";
import type { StackOperationRow } from "@maipai/spec/stack/ts/stack-model-pack.js";
import { listLoras, LORA_BASE_LTX25 } from "@/video/loras";

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

const levelsOf = (limits: PackJob["limits"]): Level[] => {
  const found = new Set<Level>();
  for (const shape of Object.values(limits.shapes ?? {})) for (const level of Object.keys(shape ?? {})) found.add(level as Level);
  for (const level of Object.keys(limits.max_seconds ?? {})) found.add(level as Level);
  const order: Level[] = ["standard", "boost", "max"];
  const levels = order.filter((l) => found.has(l));
  return levels.length ? levels : ["standard"];
};
/** The limits a job shows: the shown part's own, plus the levels (and their lengths and pixel sizes) only another part serves, so a level is never hidden behind the first part (a request naming a level is planned among the parts that serve it). */
const coverAllLevels = (shown: Serving, all: readonly Serving[]): PackJob["limits"] => {
  const limits = { ...shown.job.limits };
  const maxSeconds: Record<string, number> = { ...(limits.max_seconds ?? {}) };
  const shapes: Record<string, Record<string, unknown>> = Object.fromEntries(Object.entries(limits.shapes ?? {}).map(([name, levels]) => [name, { ...levels }]));
  for (const other of all) {
    if (other === shown) continue;
    for (const [level, seconds] of Object.entries(other.job.limits.max_seconds ?? {})) if (maxSeconds[level] === undefined) maxSeconds[level] = seconds as number;
    for (const [name, levels] of Object.entries(other.job.limits.shapes ?? {})) for (const [level, size] of Object.entries(levels ?? {})) {
      shapes[name] ??= {};
      if (shapes[name]![level] === undefined) shapes[name]![level] = size;
    }
  }
  if (Object.keys(maxSeconds).length) limits.max_seconds = maxSeconds as never;
  if (Object.keys(shapes).length) limits.shapes = shapes as never;
  return limits;
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

/** VF-CAPS-01: the jobs whose limits and capabilities are the derivation from their operation rows (video/caps.ts), so the pack JSON, the validators and this catalog are one source. */
const ROW_DERIVED_JOBS: ReadonlySet<StackJobName> = new Set<StackJobName>(["clip", "clip_from_sheet"]);
export const NOT_INSTALLED_LINE = "Not installed. An admin can add it in Settings, AI and models.";
const EDIT_UNSUPPORTED_LINE = "This computer's Max video engine cannot extend or retake a clip yet. Update Home and the Stack, then try again.";

/**
 * The rows of a job as this computer can run them now: a row is available only when the Stack's own contract says so AND its part is turned on
 * and ready AND the level fits in memory (and, for extend and retake, the installed Max runtime has the edit pipelines). A row that is off
 * says why in one plain line; a minor's catalog carries no reason (rule C10).
 */
export function catalogOperations(rows: readonly StackOperationRow[], part: StackPartView | null, options: { editSupported: boolean; audience: PartsAudience }): StackOperationRow[] {
  return rows.map((item) => {
    const { unavailable_reason: own, ...rest } = item;
    let reason: string | null = item.available ? null : own ?? "This is not available here.";
    if (reason === null) {
      if (!part || (part.state !== "ready" && part.state !== "unsupported" && part.state !== "updating")) reason = NOT_INSTALLED_LINE;
      else if (part.state === "unsupported") reason = "This computer cannot run it.";
      else if (part.state === "updating") reason = "It is being updated. Try again in a few minutes.";
      else if (!part.enabled) reason = "Turned off. An admin can turn it on in Settings, AI and models.";
      else if (!part.fits[item.level]) reason = `This does not fit in this computer's memory at the ${item.level} level. ${part.fits.reason ?? "Free some memory, or pick a smaller level."}`;
      else if ((item.operation === "extend" || item.operation === "retake") && !options.editSupported) reason = EDIT_UNSUPPORTED_LINE;
    }
    return { ...rest, available: reason === null, ...(reason !== null && options.audience === "adult" ? { unavailable_reason: reason } : {}) };
  });
}

/** VF-CONTRACT-01: every key the pinned spec's request shape for this job has: what this Stack's make door accepts (its schema is strict), so a client sends only these. Empty when the job has no request shape. */
export function requestFieldsOf(name: StackJobName): string[] {
  const option = StackMakeRequest.options.find((item) => (item.shape.job as { value?: string }).value === name);
  return option ? Object.keys(option.shape) : [];
}

export async function jobsCatalog(audience: PartsAudience, hw?: HardwareInfo): Promise<Catalog> {
  const list = await listParts({ audience, kind: "model" }, hw);

  const jobs = JOB_ORDER.flatMap((name) => {
    const serving = servingFor(name, audience, list.parts);
    if (!serving.length && audience === "minor") return []; // a job a minor may not have is absent, never explained
    const chosen = WIRED_JOBS.has(name) ? (serving.find((s) => runnable(s.part)) ?? null) : null; // a job not wired through the generic door is never "available"
    const shown = chosen ?? serving[0] ?? null;
    const limitsSource = shown ? { ...shown.job, limits: coverAllLevels(shown, serving) } : null;
    const rows = shown ? rowsForJob(shown.part.id, name) : [];
    const derived = rows.length > 0 && ROW_DERIVED_JOBS.has(name) ? jobLimitsFromRows(rows) : null;
    const limits = limitsSource && derived ? { ...limitsSource.limits, ...derived } : limitsSource?.limits;
    const capabilities = limitsSource && derived ? { ...limitsSource.capabilities, ...jobCapabilitiesFromRows(rows) } : limitsSource?.capabilities;
    const entry = {
      job: name, label: JOB_LABELS[name], available: chosen !== null,
      part: chosen ? { id: chosen.part.id, label: chosen.part.label } : null,
      limits: limits ? { levels: levelsOf(limits), ...(limits.max_seconds ? { max_seconds: limits.max_seconds } : {}), ...(limits.max_references !== undefined ? { max_references: limits.max_references } : {}), ...(limits.shapes ? { shapes: limits.shapes } : {}), ...(limits.max_words !== undefined ? { max_words: limits.max_words } : {}) } : { levels: ["standard" as Level] },
      capabilities: capabilities ?? { text: false, end_picture: false, sound: false, keeps_likeness: false },
      ...(requestFieldsOf(name).length > 0 ? { request_fields: requestFieldsOf(name) } : {}),
      ...(rows.length > 0 ? { operations: catalogOperations(rows, shown!.part, { editSupported: ltx25MaxEditSupported(), audience }) } : {}),
      styles: { bases: shown?.pack.pack.style_bases?.filter((b) => !b.retired).map(({ browse: _browse, retired: _retired, ...served }) => served) ?? [], max: 0 },
      restyles: name === "clip" && shown?.part.id === "ltx-2-5-bf16-distilled-mlx-max" ? listLoras().filter((item) => (item.base_model ?? "") === LORA_BASE_LTX25).map((item) => ({ name: item.id, label: item.name })) : [] as Array<{ name: string; label: string }>,
    };
    if (audience === "minor") return [entry];
    const why = chosen ? null : serving.length && !WIRED_JOBS.has(name) ? `This kind of job is not available through the generic door yet. An admin does not need to do anything.` : serving.length
      ? `No model that can ${JOB_PHRASE[name]} is turned on and ready. An admin can turn one on or add one in Settings, AI and models.`
      : `No model that can ${JOB_PHRASE[name]} is installed here. An admin can add one in Settings, AI and models.`;
    return [{ ...entry, why_not: why, alternatives: serving.filter((s) => s !== chosen).map((s) => ({ part: s.part.id, label: s.part.label })) }];
  });
  const parsed = StackJobsCatalog.safeParse({ audience, jobs, spec: specPackage.version });
  if (!parsed.success) throw new Error(`The jobs catalog does not match the spec: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}
