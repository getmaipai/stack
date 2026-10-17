// The disk plan: what each install costs on disk, per component and per
// tier, from one place. Download and installed sizes of every model come
// from the shipped pins (`approx_bytes`) and a measured table
// (diskPlanMeasured.json) that holds what the files take once
// installed, the Python engine environments, Home itself and the peak
// temporary space an install needs. tests/diskPlan.test.ts fails when a
// pin's bytes change without the table being re-measured, so the numbers
// the installer, the wizard and Settings show cannot drift from the pins.
// Pure: the install plan route supplies nothing but the tier.
import measured from "@/lib/diskPlanMeasured.json";
import { PROFILE_TIERS, type ProfileTier } from "@/profiles";
import {
  CHATTERBOX_ENGINE, STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_TOOL_MODELS, STACK_IMAGE_ZIMAGE_MODELS,
  STACK_MODELS, STACK_VIDEO_MODELS,
} from "@/lib/modelCatalog";
import { plannedPinsFor } from "@/lib/installPlan";
import type { CatalogModelLike } from "@/lib/modelStore";

export type DiskNeed = "required" | "recommended" | "optional";
export type DiskRowKind = "home" | "model" | "engine";
export type DiskBasis = "pins" | "measured" | "estimate";

export interface DiskRow {
  id: string;
  /** Plain words a person reads in the wizard and Settings. */
  label: string;
  /** One short line on what it is for. */
  note: string;
  kind: DiskRowKind;
  need: DiskNeed;
  /** False for rows the person cannot turn off (required rows, engine environments, the search helper). */
  selectable: boolean;
  /** Bytes to download. */
  download_bytes: number;
  /** Bytes on disk once installed. */
  installed_bytes: number;
  /** Extra bytes needed only while installing (archives, package caches, build space). */
  peak_temp_bytes: number;
  /** The pins this row installs; the install plan's models and the pull bodies name the same ids. */
  model_ids: string[];
  /** Engine environment rows (by id) this row cannot run without; counted once however many rows name them. */
  engines: string[];
  /** Every pin of this row is already on this computer (always false for rows with no pins). */
  installed: boolean;
  /** Where the number comes from: the pins' byte counts, a measurement on a real install, or an estimate. */
  basis: DiskBasis;
}

export interface DiskTotals {
  download_bytes: number;
  installed_bytes: number;
  peak_temp_bytes: number;
  /** installed + peak temp, before the safety margin. */
  needed_bytes: number;
  /** needed + margin on the installed part: the free space asked for. */
  required_free_bytes: number;
}

export interface DiskPlan {
  tier: ProfileTier["id"];
  level: ProfileTier["level"];
  margin_percent: number;
  /** Warn when free space clears the requirement by less than this. */
  headroom_warn_bytes: number;
  rows: DiskRow[];
  /** Required and recommended rows (the default selection). */
  default: DiskTotals;
  /** Required rows only. */
  minimum: DiskTotals;
  /** Everything the tier offers, optional extras included. */
  everything: DiskTotals;
  measured_on: string;
  /** The ids a fresh install selects: required and recommended. */
  default_selected: string[];
}

type PinSizes = Record<string, { download_bytes: number; installed_bytes: number }>;
type EngineSizes = Record<string, { installed_bytes: number; download_bytes: number; peak_temp_bytes: number; basis: DiskBasis }>;
const table = measured as { measured_on: string; margin_percent: number; headroom_warn_bytes: number; pins: PinSizes; engines: EngineSizes };

export const DISK_MARGIN_PERCENT = table.margin_percent;
export const DISK_MEASURED_ON = table.measured_on;

const GIB = 1_073_741_824;
const TIER_ORDER = ["p16", "p32", "p64", "p128"] as const;

function pinBytes(pin: CatalogModelLike): { download: number; installed: number; temp: number } {
  const row = table.pins[pin.id];
  const download = pin.download?.approx_bytes ?? 0;
  const installed = row?.installed_bytes ?? download;
  // An archive is kept beside what it unpacks to until the unpack finishes.
  return { download, installed, temp: pin.download?.archive ? download : 0 };
}

function modelRow(base: Pick<DiskRow, "id" | "label" | "note" | "need" | "engines"> & { selectable?: boolean }, pins: CatalogModelLike[]): DiskRow {
  const sums = pins.reduce((acc, pin) => { const size = pinBytes(pin); return { download: acc.download + size.download, installed: acc.installed + size.installed, temp: acc.temp + size.temp }; }, { download: 0, installed: 0, temp: 0 });
  return {
    id: base.id, label: base.label, note: base.note, kind: "model", need: base.need, selectable: base.selectable ?? base.need !== "required",
    download_bytes: sums.download, installed_bytes: sums.installed, peak_temp_bytes: sums.temp, model_ids: pins.map((pin) => pin.id), engines: base.engines, installed: false, basis: "pins",
  };
}

function engineRow(id: string, key: string, label: string, note: string): DiskRow {
  const size = table.engines[key];
  if (!size) throw new Error(`diskPlan: the measured table has no engine "${key}". Run bun run measure:disk-plan.`);
  return { id, label, note, kind: "engine", need: "required", selectable: false, download_bytes: size.download_bytes, installed_bytes: size.installed_bytes, peak_temp_bytes: size.peak_temp_bytes, model_ids: [], engines: [], installed: false, basis: size.basis };
}

/** The plain name of a chat pin for the row's label. */
export function chatName(pin: CatalogModelLike): string {
  if (/muse-glimmer-30b/.test(pin.id)) return "Muse Glimmer 30B";
  if (/qwen3-8b/.test(pin.id)) return "Qwen3 8B";
  if (/qwen3-1\.7b/.test(pin.id)) return "Qwen3 1.7B";
  return pin.id;
}

const ENGINE_ROWS: Record<string, () => DiskRow> = {
  "engine:python": () => engineRow("engine:python", "python-base", "Python base for the engines", "The shared Python the voice and picture engines run on."),
  "engine:voice": () => engineRow("engine:voice", "pocket-tts", "Voice engine tools", "What the voice runs on."),
  "engine:voice-better": () => engineRow("engine:voice-better", "mlx-audio", "Better voice engine tools", "What the expressive voice runs on."),
  "engine:pictures": () => engineRow("engine:pictures", "image-gen", "Picture engine tools", "What making pictures runs on."),
  "engine:image-tools": () => engineRow("engine:image-tools", "image-tools", "Picture editing engine tools", "What removing a background, erasing and enlarging run on."),
  "engine:video": () => engineRow("engine:video", "video-gen", "Video engine tools", "What making videos runs on."),
};
const PYTHON_ENGINES = ["engine:voice", "engine:voice-better", "engine:pictures", "engine:image-tools", "engine:video"];

function totals(rows: DiskRow[], selected: Set<string>): DiskTotals {
  const chosen = rows.filter((row) => selected.has(row.id));
  const engineIds = new Set(chosen.flatMap((row) => row.engines));
  const counted = [...chosen.filter((row) => row.kind !== "engine"), ...rows.filter((row) => row.kind === "engine" && (selected.has(row.id) || engineIds.has(row.id)))];
  const sum = (pick: (row: DiskRow) => number) => counted.reduce((acc, row) => acc + pick(row), 0);
  const installed = sum((row) => row.installed_bytes);
  const temp = sum((row) => row.peak_temp_bytes);
  return { download_bytes: sum((row) => row.download_bytes), installed_bytes: installed, peak_temp_bytes: temp, needed_bytes: installed + temp, required_free_bytes: Math.ceil(installed * (1 + table.margin_percent / 100)) + temp };
}

/** The disk plan of one tier. A row's `need` is what the tier's table says: required rows are the AI that keeps chat, memory
 * and voice working, recommended rows are on by default and safe to turn off, optional rows are off by default. */
export function buildDiskPlan(tier: ProfileTier, installedIds: Iterable<string> = []): DiskPlan {
  const present = new Set(installedIds);
  const planned = plannedPinsFor(tier);
  const projectors = new Set(STACK_MODELS.flatMap((pin) => pin.imageInput ? [pin.imageInput.projector] : []));
  const chatterbox = new Set(STACK_MODELS.filter((pin) => pin.engine === CHATTERBOX_ENGINE).map((pin) => pin.id));
  const imageTools = new Set(STACK_IMAGE_TOOL_MODELS.map((pin) => pin.id));
  const plannedWhere = (test: (pin: CatalogModelLike) => boolean) => planned.map((entry) => entry.pin).filter(test);
  const chat = plannedWhere((pin) => pin.role === "chat" && !projectors.has(pin.id));
  const bigChat = chat.find((pin) => !/qwen3-1\.7b/.test(pin.id)) ?? chat[0];
  const rows: DiskRow[] = [];
  rows.push({
    id: "home", label: "Home itself", note: "Home, the AI program that runs the models, and the space the install needs to build them.", kind: "home", need: "required", selectable: false,
    download_bytes: table.engines.home!.download_bytes, installed_bytes: table.engines.home!.installed_bytes, peak_temp_bytes: table.engines.home!.peak_temp_bytes, model_ids: [], engines: [], installed: false, basis: table.engines.home!.basis,
  });
  if (chat.length) {
    const starter = chat.length > 1 ? " A small starter chat AI (Qwen3 1.7B) comes first so you can talk while the big one downloads." : "";
    rows.push(modelRow({ id: "chat", label: `Chat AI (${chatName(bigChat!)})`, note: `The AI you talk to.${starter}`, need: "required", engines: [] }, chat));
  }
  const reads = plannedWhere((pin) => projectors.has(pin.id));
  if (reads.length) rows.push(modelRow({ id: "reads-pictures", label: "Reads pictures (projector)", note: "Lets the chat AI look at a picture you send it.", need: "recommended", engines: [] }, reads));
  const judge = plannedWhere((pin) => pin.role === "judge");
  if (judge.length) rows.push(modelRow({ id: "judge", label: "Quick helper AI", note: "A second, smaller AI that double-checks answers.", need: "required", engines: [] }, judge));
  const embed = plannedWhere((pin) => pin.role === "embed");
  if (embed.length) rows.push(modelRow({ id: "embed", label: "Memory search model", note: "Finds what Home remembers when you ask.", need: "required", engines: [] }, embed));
  const stt = plannedWhere((pin) => pin.role === "stt");
  if (stt.length) rows.push(modelRow({ id: "stt", label: "Speech to text", note: "Turns what you say into words, on this computer.", need: "required", engines: [] }, stt));
  const voice = plannedWhere((pin) => pin.role === "tts" && !chatterbox.has(pin.id));
  if (voice.length) rows.push(modelRow({ id: "voice", label: "Voice (Pocket TTS)", note: "Home's spoken voice.", need: "required", engines: ["engine:voice", "engine:python"] }, voice));
  const better = plannedWhere((pin) => chatterbox.has(pin.id));
  if (better.length) rows.push(modelRow({ id: "voice-better", label: "Voice (Chatterbox)", note: "A more expressive spoken voice. Pocket TTS stays as the fallback.", need: "recommended", engines: ["engine:voice-better", "engine:python"] }, better));
  const tools = plannedWhere((pin) => imageTools.has(pin.id));
  if (tools.length) rows.push(modelRow({ id: "image-tools", label: "Edit pictures tools", note: "Remove a background, erase something, make a picture bigger.", need: "recommended", engines: ["engine:image-tools", "engine:python"] }, tools));
  if (!tier.notAvailable.includes("image")) {
    rows.push(modelRow({ id: "pictures", label: "Make pictures (FLUX.2 Klein)", note: "Makes pictures from a sentence, and edits yours.", need: "recommended", engines: ["engine:pictures", "engine:python"] }, STACK_IMAGE_KLEIN_MODELS));
    if (TIER_ORDER.indexOf(tier.id) >= TIER_ORDER.indexOf("p128")) rows.push(modelRow({ id: "pictures-zimage", label: "More picture styles (Z-Image Turbo)", note: "A second picture maker with a different look. Optional.", need: "optional", engines: ["engine:pictures", "engine:python"] }, STACK_IMAGE_ZIMAGE_MODELS));
  }
  if (!tier.notAvailable.includes("video")) rows.push(modelRow({ id: "video", label: "Make videos (Wan2.2)", note: "Makes a short clip from a sentence or a picture. Optional.", need: "optional", engines: ["engine:video", "engine:python"] }, STACK_VIDEO_MODELS));
  const search = table.engines["search-helper"]!;
  rows.push({ id: "search", label: "Search helper", note: "Looks up web search results for adults, when web search is turned on.", kind: "model", need: "recommended", selectable: false, download_bytes: search.download_bytes, installed_bytes: search.installed_bytes, peak_temp_bytes: search.peak_temp_bytes, model_ids: [], engines: [], installed: false, basis: search.basis });
  const used = new Set(rows.flatMap((row) => row.engines));
  for (const id of ["engine:python", ...PYTHON_ENGINES]) if (used.has(id)) rows.push(ENGINE_ROWS[id]!());
  for (const row of rows) row.installed = row.model_ids.length > 0 && row.model_ids.every((id) => present.has(id));
  const all = new Set(rows.map((row) => row.id));
  const byNeed = (...needs: DiskNeed[]) => new Set(rows.filter((row) => needs.includes(row.need) && row.kind !== "engine").map((row) => row.id));
  return {
    tier: tier.id, level: tier.level, margin_percent: table.margin_percent, headroom_warn_bytes: table.headroom_warn_bytes, rows,
    default: totals(rows, byNeed("required", "recommended")), minimum: totals(rows, byNeed("required")), everything: totals(rows, all),
    measured_on: table.measured_on, default_selected: rows.filter((row) => row.kind !== "engine" && row.need !== "optional").map((row) => row.id),
  };
}

export function diskPlanForTier(id: ProfileTier["id"], installedIds: Iterable<string> = []): DiskPlan | null {
  const tier = PROFILE_TIERS.find((candidate) => candidate.id === id);
  return tier ? buildDiskPlan(tier, installedIds) : null;
}

/** Totals for a person's selection (row ids, engine rows implied). Exported for the tests that hold the same sums the clients make. */
export function diskTotalsFor(plan: DiskPlan, selected: Iterable<string>): DiskTotals {
  return totals(plan.rows, new Set(selected));
}

/** Everything a client needs without the Stack: every tier's plan, written to docs/disk-plan.json by scripts/gen-disk-plan.ts. */
export function diskPlanExport() {
  const tiers = Object.fromEntries(PROFILE_TIERS.map((tier) => [tier.id, buildDiskPlan(tier)]));
  const flat: Record<string, number> = {};
  for (const tier of PROFILE_TIERS) {
    const plan = tiers[tier.id]!;
    flat[`${tier.id}.required_free_bytes`] = plan.default.required_free_bytes;
    flat[`${tier.id}.minimum_required_free_bytes`] = plan.minimum.required_free_bytes;
    flat[`${tier.id}.everything_required_free_bytes`] = plan.everything.required_free_bytes;
    flat[`${tier.id}.needed_bytes`] = plan.default.needed_bytes;
  }
  return { measured_on: table.measured_on, margin_percent: table.margin_percent, headroom_warn_bytes: table.headroom_warn_bytes, gib_bytes: GIB, installer: flat, tiers };
}
