// The disk plan: what each install costs on disk, per component and per
// tier, from one place. Download and installed sizes of every model come
// from the shipped pins (`approx_bytes`) and a measured table
// (diskPlanMeasured.json) that holds what the files take once
// installed, the Python engine environments, Home itself and the peak
// temporary space an install needs. tests/diskPlan.test.ts fails when a
// pin's bytes change without the table being re-measured, so the numbers
// the installer, the wizard and Settings show cannot drift from the pins.
// Pure: the install plan route supplies nothing but the tier.
import { PICTURE_READER_ROLE, PRIMARY_ROLE } from "@/roles";
import measured from "@/lib/diskPlanMeasured.json";
import diskRoleRowsJson from "@/rows/diskRoleRows.json";
import diskModelRowsJson from "@/rows/diskModelRows.json";
import diskRowGatesJson from "@/rows/diskRowGates.json";
import diskRowFeaturesJson from "@/rows/diskRowFeatures.json";
import { partDef, partLabel } from "@/lib/partDefs";
import { PROFILE_TIERS, type ProfileTier } from "@/profiles";
import {
  SPLASH_LOCAL_CHAT_MODELS, voxcpm2PackFor, VOXCPM2_ENGINE, VOXCPM2_REDUCED_ENGINE,
  CHATTERBOX_ENGINE, STACK_IMAGE_ERNIE_MODELS, STACK_IMAGE_H3_MODELS, STACK_IMAGE_KLEIN3_MODELS, STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_QWEN_MODELS, STACK_IMAGE_RESTORE_MODELS, STACK_IMAGE_TOOL_MODELS, STACK_IMAGE_ZIMAGE_MODELS, STACK_LIVEPORTRAIT_MODELS,
  STACK_MODELS, STACK_MUSIC_MODELS, STACK_MUSIC_WHISPER, STACK_MUSIC_MAX_MODELS, STACK_MUSIC_XL_MODELS, STACK_ALIGN_MODELS, STACK_SFX_MODELS, STACK_STEMS_MODELS, STACK_RECORDED_SPEECH_MODELS, STACK_VIDEO_MODELS, STACK_VIDEO_LTX25_MAX_MODELS, STACK_VIDEO_LTX25_MODELS, STACK_VIDEO_H3_MODELS, STACK_VIDEO_MASK_MODELS,
} from "@/lib/modelCatalog";
import { plannedPinsFor } from "@/lib/installPlan";
import type { CatalogModelLike } from "@/lib/modelStore";
import { IMAGE_FAMILIES } from "@/images/models";
import { PROFILE_IDS } from "@/lib/profileIds";

export const TALKING_PICTURES_ROW = "talking-pictures";
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
  /** The feature row (rows/featureRows.json id) this row belongs to, so a client groups rows without its own table; null for Home itself and the shared helpers, and for engine environments. */
  feature?: string | null;
  /** WAN-DEFAULT-01: the row installs a model made for minors only (the silent video model); an adult-only home is never offered it, a home with a child or teen starts it on. */
  minors_only?: boolean;
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

/** One plain-role install-plan row from rows/diskRoleRows.json: the part whose partLabel is the label, the need, the engines, and a fixed note only when the note is not the part's own description. */
interface DiskRoleRow { id: string; role: string; part: string; need: DiskNeed; engines: string[]; note?: string }
const DISK_ROLE_ROWS = diskRoleRowsJson as DiskRoleRow[];

/** One entry of rows/diskModelRows.json: an optional model row. The part gives the label and the default note, `pins` names the pin set the row installs. Any of `unlessNotAvailable` (a feature this template does without), `gate` (a gated row id) and `family` (a picture family that lists the templates it runs on) may be present; every guard the row carries has to pass before the template is offered it. `noteExtra` is appended to the default note and `recommendedFrom` turns the row recommended at that template and above. */
interface DiskModelRow { id: string; part: string; need: DiskNeed; engines: string[]; pins: string; unlessNotAvailable?: string; gate?: string; family?: string; plannedInstead?: { part: string; pins: string }; noteExtra?: string; recommendedFrom?: string }
const DISK_MODEL_ROWS = diskModelRowsJson as DiskModelRow[];

/** The pin sets a model row installs, under the names rows/diskModelRows.json gives them. A single pin is listed as a one-item set. */
const PIN_SETS: Record<string, readonly CatalogModelLike[]> = {
  STACK_IMAGE_ERNIE_MODELS, STACK_IMAGE_H3_MODELS, STACK_IMAGE_KLEIN3_MODELS, STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_QWEN_MODELS, STACK_IMAGE_RESTORE_MODELS, STACK_IMAGE_ZIMAGE_MODELS,
  STACK_LIVEPORTRAIT_MODELS, STACK_MUSIC_MAX_MODELS, STACK_MUSIC_MODELS, STACK_MUSIC_WHISPER: [STACK_MUSIC_WHISPER], STACK_MUSIC_XL_MODELS, STACK_SFX_MODELS,
  STACK_VIDEO_H3_MODELS, STACK_VIDEO_LTX25_MAX_MODELS, STACK_VIDEO_LTX25_MODELS, STACK_VIDEO_MASK_MODELS, STACK_VIDEO_MODELS,
};

type PinSizes = Record<string, { download_bytes: number; installed_bytes: number }>;
type EngineSizes = Record<string, { installed_bytes: number; download_bytes: number; peak_temp_bytes: number; basis: DiskBasis }>;
const table = measured as { measured_on: string; margin_percent: number; headroom_warn_bytes: number; pins: PinSizes; engines: EngineSizes };

export const DISK_MARGIN_PERCENT = table.margin_percent;
/** The measured download of one engine environment (the components list sizes an install from the same table the wizard uses). */
export function engineDownloadBytes(key: string): number | null { return table.engines[key]?.download_bytes ?? null; }
export const DISK_MEASURED_ON = table.measured_on;

const GIB = 1_073_741_824;
const TIER_ORDER = PROFILE_IDS;

/** One entry of rows/diskRowGates.json: the smallest template that may offer the row, plus the feature the row belongs to when it has one. */
interface DiskRowGate { minTier: string; feature?: string }
const DISK_ROW_FEATURES: Record<string, string | null> = diskRowFeaturesJson;
const DISK_ROW_GATES: Record<string, DiskRowGate> = diskRowGatesJson;

/** DISKGATE-01: whether a hardware template may offer one of the gated optional disk-plan rows. The row is hidden when the template lists the row's feature as not available, or when the template sits below the row's minimum tier. */
export function rowAllowed(tier: { id: string; notAvailable: readonly string[] }, rowId: string): boolean {
  const gate = DISK_ROW_GATES[rowId];
  if (!gate) throw new Error("no disk row gate for " + rowId);
  if (gate.feature !== undefined && tier.notAvailable.includes(gate.feature)) return false;
  return TIER_ORDER.indexOf(tier.id) >= TIER_ORDER.indexOf(gate.minTier);
}

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
export function chatName(pin: CatalogModelLike): string { return partLabel(pin.id); }

const ENGINE_ROWS: Record<string, () => DiskRow> = {
  "engine:python": () => engineRow("engine:python", "python-base", "Python base for the engines", "The shared Python the voice and picture engines run on."),
  "engine:voice": () => engineRow("engine:voice", "pocket-tts", "Voice engine tools", "What the voice runs on."),
  "engine:voice-better": () => engineRow("engine:voice-better", "mlx-audio", "Better voice engine tools", "What the expressive voice runs on."),
  "engine:voice-voxcpm2": () => engineRow("engine:voice-voxcpm2", "voxcpm2", "Optional voice engine tools", "What the optional natural voice runs on."),
  "engine:pictures": () => engineRow("engine:pictures", "image-gen", "Picture engine tools", "What making pictures runs on."),
  "engine:pictures-h3": () => engineRow("engine:pictures-h3", "h3-image-gen", "Picture model engine tools", "What the picture model runs on."),
  "engine:image-tools": () => engineRow("engine:image-tools", "image-tools", "Picture editing engine tools", "What removing a background, erasing and enlarging run on."),
  "engine:liveportrait": () => engineRow("engine:liveportrait", "liveportrait", "Companion animation engine tools", "What making a companion's mouth and blink pictures runs on (about 1.5 GB, built on first use from pinned sources)."),
  "engine:video": () => engineRow("engine:video", "video-gen", "Video engine tools", "What making videos runs on."),
  "engine:video-ltx25": () => engineRow("engine:video-ltx25", "ltx25-gen", "LTX-2.5 video engine tools", "What the LTX-2.5 videos run on."),
  "engine:video-ltx25-max": () => engineRow("engine:video-ltx25-max", "ltx25-max-gen", "LTX-2.5 Max video engine tools", "What the LTX-2.5 Max videos run on."),
  "engine:video-mask": () => engineRow("engine:video-mask", "mask-gen", "SAM 2.1 mask tools", "What tracking a subject through a clip runs on."),
  "engine:music": () => engineRow("engine:music", "music-gen", "Music engine tools", "What making songs runs on."),
  "engine:sound-effects": () => engineRow("engine:sound-effects", "sfx-gen", "Sound effects engine tools", "What making sound effects runs on."),
  "engine:swap-composite": () => engineRow("engine:swap-composite", "composite-swap", "Swap composite tools", "What putting a new head into a clip and keeping the rest runs on."),
  "engine:score": () => engineRow("engine:score", "score-gen", "Score engine tools", "What turning audio into notes runs on."),
  "engine:stems": () => engineRow("engine:stems", "stems", "Stem splitting tools", "What separating song stems runs on."),
  "engine:align": () => engineRow("engine:align", "align", "Lyric timing tools", "What timing a song's words runs on."),
  "engine:beats": () => engineRow("engine:beats", "beats", "Beat scanner tools", "What detecting beats and sections runs on."),
  "engine:voice-convert": () => engineRow("engine:voice-convert", "voice-convert", "Voice conversion tools", "What converting a singing voice runs on."),
  "engine:recorded-speech": () => engineRow("engine:recorded-speech", "recorded-speech", "Recorded speech tools", "What recorded speech rendering runs on."),
  "engine:chat-mlx": () => engineRow("engine:chat-mlx", "omlx", "Faster chat engine tools (oMLX)", "What the faster chat engine runs on. llama.cpp stays as the fallback."),
};
const PYTHON_ENGINES = ["engine:chat-mlx", "engine:voice", "engine:voice-better", "engine:voice-voxcpm2", "engine:pictures", "engine:pictures-h3", "engine:image-tools", "engine:liveportrait", "engine:video", "engine:video-ltx25", "engine:video-ltx25-max", "engine:video-mask", "engine:music", "engine:sound-effects", "engine:score", "engine:swap-composite", "engine:stems", "engine:align", "engine:beats", "engine:voice-convert", "engine:recorded-speech"];

function totals(rows: DiskRow[], selected: Set<string>, only?: "home" | "ai"): DiskTotals {
  const chosen = rows.filter((row) => selected.has(row.id));
  const engineIds = new Set(chosen.flatMap((row) => row.engines));
  const counted = [...chosen.filter((row) => row.kind !== "engine"), ...rows.filter((row) => row.kind === "engine" && (selected.has(row.id) || engineIds.has(row.id)))]
    .filter((row) => only === undefined || (only === "home") === (row.kind === "home"));
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
  const imageTools = new Set(STACK_IMAGE_TOOL_MODELS.filter((pin) => pin.component !== "tool-look").map((pin) => pin.id));
  const plannedWhere = (test: (pin: CatalogModelLike) => boolean) => planned.map((entry) => entry.pin).filter(test);
  const chat = plannedWhere((pin) => pin.role === PRIMARY_ROLE && !projectors.has(pin.id));
  const bigChat = chat[0];
  const rows: DiskRow[] = [];
  rows.push({
    id: "home", label: "Home itself", note: "Home, the AI program that runs the models, and the space the install needs to build them.", kind: "home", need: "required", selectable: false,
    download_bytes: table.engines.home!.download_bytes, installed_bytes: table.engines.home!.installed_bytes, peak_temp_bytes: table.engines.home!.peak_temp_bytes, model_ids: [], engines: [], installed: false, basis: table.engines.home!.basis,
  });
  if (chat.length) {
    rows.push(modelRow({ id: PRIMARY_ROLE, label: `Chat AI (${chatName(bigChat!)})`, note: "The AI you talk to.", need: "required", engines: chat.some((pin) => pin.engine === "omlx") ? ["engine:chat-mlx", "engine:python"] : [] }, chat));
  }
  // A row that would list a model an earlier row already holds is left out: the plan names each model once (the 128 GB lineup plans the Splash 35B as its chat model).
  const held = (pins: CatalogModelLike[]) => rows.some((row) => row.model_ids.includes(pins[0]?.id ?? ""));
  for (const entry of SPLASH_LOCAL_CHAT_MODELS) if (entry.profiles.includes(tier.id) && !held([entry.pin])) rows.push(modelRow({ id: entry.row, label: partLabel(entry.pin.id), note: "Optional chat model run by Splash, with its speed-up files. Install both, then choose it in Settings.", need: "optional", engines: [] }, [entry.pin, entry.draftPin]));
  const reads = plannedWhere((pin) => projectors.has(pin.id) && pin.role !== PICTURE_READER_ROLE);
  if (reads.length) rows.push(modelRow({ id: "reads-pictures", label: partLabel("qwen3-vl-8b-instruct-q4-k-m"), note: "Lets the chat AI look at a picture you send it.", need: "recommended", engines: [] }, reads));
  // The plain-role rows (the picture reader that checks finished clips and pictures for safety when chat cannot read
  // pictures, AIMODELS-VISION-01; the judge; the coding model, which rides the recommended setup but an admin can leave
  // out or remove it later, CODE-STACK-01; the memory helper; speech-to-text) come from rows/diskRoleRows.json.
  for (const entry of DISK_ROLE_ROWS) {
    const pins = plannedWhere((pin) => pin.role === entry.role);
    if (pins.length) rows.push(modelRow({ id: entry.id, label: partLabel(entry.part), note: entry.note ?? partDef(entry.part)!.description, need: entry.need, engines: entry.engines }, pins));
  }
  const voice = plannedWhere((pin) => pin.role === "tts" && !chatterbox.has(pin.id));
  // The voice row is Pocket TTS, or VoxCPM2 where the template's plan brings that voice instead (the 128 GB lineup).
  const voiceIsVoxcpm2 = voice.some((pin) => pin.id === "voxcpm2-bf16");
  const voicePart = voiceIsVoxcpm2 ? "voxcpm2-bf16" : "pocket-tts-english";
  if (voice.length) rows.push(modelRow({ id: "voice", label: partLabel(voicePart), note: partDef(voicePart)!.description, need: "required", engines: voiceIsVoxcpm2 ? ["engine:voice-voxcpm2", "engine:python"] : ["engine:voice", "engine:python"] }, voice));
  const better = plannedWhere((pin) => chatterbox.has(pin.id));
  if (better.length) rows.push(modelRow({ id: "voice-better", label: partLabel("chatterbox-turbo-fp16"), note: partDef("chatterbox-turbo-fp16")!.description, need: "recommended", engines: ["engine:voice-better", "engine:python"] }, better));
  // voxcpm2 (VOICE-VOXCPM2-01 step 2): two optional rows, off by default, never in the first-run set; the voice is chosen by name in the voice engine setting afterwards.
  // Each size brings its own files and the clip speech-to-text (a shared companion, counted once per row because the rows are alternatives).
  if (rowAllowed(tier, "voice-voxcpm2") && !voiceIsVoxcpm2) rows.push(modelRow({ id: "voice-voxcpm2", label: partLabel("voxcpm2-bf16"), note: `${partDef("voxcpm2-bf16")!.description} Apache-2.0 licence; its listening helper is CC-BY-4.0. Install it, then choose it in Settings, Voice engine.`, need: "optional", engines: ["engine:voice-voxcpm2", "engine:python"] }, voxcpm2PackFor(VOXCPM2_ENGINE)));
  if (rowAllowed(tier, "voice-voxcpm2-reduced")) rows.push(modelRow({ id: "voice-voxcpm2-reduced", label: partLabel("voxcpm2-4bit"), note: `${partDef("voxcpm2-4bit")!.description} Apache-2.0 licence; its listening helper is CC-BY-4.0. Install it, then choose it in Settings, Voice engine.`, need: "optional", engines: ["engine:voice-voxcpm2", "engine:python"] }, voxcpm2PackFor(VOXCPM2_REDUCED_ENGINE)));
  const tools = plannedWhere((pin) => imageTools.has(pin.id));
  if (tools.length) rows.push(modelRow({ id: "image-tools", label: partLabel("image-tools"), note: partDef("image-tools")!.description, need: "recommended", engines: ["engine:image-tools", "engine:python"] }, tools));
  const look = STACK_IMAGE_TOOL_MODELS.filter((pin) => pin.component === "tool-look");
  if (look.length) rows.push(modelRow({ id: "tool-look", label: partLabel("tool-look"), note: partDef("tool-look")!.description, need: "optional", engines: ["engine:image-tools", "engine:python"] }, look));
  // The model rows come from rows/diskModelRows.json, in the order they are listed there: the part names the label and
  // the note, the pin set names what the row installs, and each row's own guard says which templates may offer it. A row
  // the builder picks out another way (a voice, a picture tool, or one of the score, stem, aligner and singer helpers,
  // which every template offers and that therefore carry no guard) stays here, in the place it always held in the order.
  for (const entry of DISK_MODEL_ROWS) {
    if (entry.unlessNotAvailable !== undefined && (tier.notAvailable as readonly string[]).includes(entry.unlessNotAvailable)) continue;
    if (entry.gate !== undefined && !rowAllowed(tier, entry.gate)) continue;
    if (entry.family !== undefined) {
      const family = IMAGE_FAMILIES[entry.family as keyof typeof IMAGE_FAMILIES];
      if (!family) throw new Error(`diskPlan: row "${entry.id}" names the picture family "${entry.family}", which the family table does not have.`);
      if (!(family.tiers as string[]).includes(tier.id)) continue;
    }
    let pins = PIN_SETS[entry.pins];
    if (!pins) throw new Error(`diskPlan: row "${entry.id}" names the pin set "${entry.pins}", which diskPlan.ts does not know.`);
    let part = entry.part;
    // The required pictures row follows the plan: where the plan brings the other everyday picture model instead (the 128 GB lineup), the row is that one.
    const instead = entry.plannedInstead;
    if (instead && planned.some((p) => p.pin.id === PIN_SETS[instead.pins]![0]!.id) && !planned.some((p) => p.pin.id === pins![0]!.id)) { pins = PIN_SETS[instead.pins]!; part = instead.part; }
    else if (entry.need !== "required" && held([...pins])) continue;
    // A row with recommendedFrom is recommended once the template reaches that size; below it the row keeps its own need.
    const need: DiskNeed = entry.recommendedFrom !== undefined && TIER_ORDER.indexOf(tier.id) >= TIER_ORDER.indexOf(entry.recommendedFrom) ? "recommended" : entry.need;
    rows.push(modelRow({ id: entry.id, label: partLabel(part), note: partDef(part)!.description + (entry.noteExtra ?? ""), need, engines: entry.engines }, [...pins]));
  }
  rows.push({ id: "score-transcription", label: partLabel("score-gen"), note: partDef("score-gen")!.description, kind: "model", need: "optional", selectable: true, download_bytes: 0, installed_bytes: 0, peak_temp_bytes: 0, model_ids: [], engines: ["engine:score", "engine:python"], installed: false, basis: "measured" });
  rows.push(modelRow({ id: "stems", label: partLabel("htdemucs"), note: partDef("htdemucs")!.description, need: "recommended", engines: ["engine:stems", "engine:python"] }, [STACK_STEMS_MODELS[0]!]));
  rows.push(modelRow({ id: "stems-ft", label: partLabel("htdemucs-ft"), note: partDef("htdemucs-ft")!.description, need: "optional", engines: ["engine:stems", "engine:python"] }, [STACK_STEMS_MODELS[1]!]));
  rows.push(modelRow({ id: "stems-6s", label: partLabel("htdemucs-6s"), note: partDef("htdemucs-6s")!.description, need: "optional", engines: ["engine:stems", "engine:python"] }, [STACK_STEMS_MODELS[2]!]));
  rows.push(modelRow({ id: "align", label: partLabel("mms-fa-align"), note: partDef("mms-fa-align")!.description, need: "optional", engines: ["engine:align", "engine:python"] }, STACK_ALIGN_MODELS));
  rows.push(modelRow({ id: "voice-convert", label: partLabel("soulx-singer-svc"), note: partDef("soulx-singer-svc")!.description, need: "optional", engines: ["engine:voice-convert", "engine:python"] }, STACK_MODELS.filter((pin) => pin.component === "voice-convert")));
  rows.push(modelRow({ id: "recorded-speech", label: partLabel("fish-audio-drama-3-4bit"), note: partDef("fish-audio-drama-3-4bit")!.description, need: "recommended", engines: ["engine:recorded-speech", "engine:python"] }, STACK_RECORDED_SPEECH_MODELS));
  // ffmpeg and ffprobe: one pinned archive (media/pins.ts), required because songs, voice shifting and clips cut with it. No model pins.
  const ffmpeg = table.engines.ffmpeg!;
  rows.push({ id: "ffmpeg", label: partLabel("ffmpeg"), note: partDef("ffmpeg")!.description, kind: "model", need: "required", selectable: false, download_bytes: ffmpeg.download_bytes, installed_bytes: ffmpeg.installed_bytes, peak_temp_bytes: ffmpeg.peak_temp_bytes, model_ids: [], engines: [], installed: false, basis: ffmpeg.basis });
  rows.push({ id: "shazam-signature", label: partLabel("shazam-signature"), note: partDef("shazam-signature")!.description, kind: "model", need: "optional", selectable: true, download_bytes: 1_700_000, installed_bytes: 1_700_000, peak_temp_bytes: 0, model_ids: [], engines: [], installed: false, basis: "pins" });
  const search = table.engines["search-helper"]!;
  rows.push({ id: "search", label: "Search helper", note: "Looks up web search results for adults, when web search is turned on.", kind: "model", need: "recommended", selectable: false, download_bytes: search.download_bytes, installed_bytes: search.installed_bytes, peak_temp_bytes: search.peak_temp_bytes, model_ids: [], engines: [], installed: false, basis: search.basis });
  const used = new Set(rows.flatMap((row) => row.engines));
  for (const id of ["engine:python", ...PYTHON_ENGINES]) if (used.has(id)) rows.push(ENGINE_ROWS[id]!());
  for (const row of rows) row.installed = row.model_ids.some((id) => present.has(id));
  const all = new Set(rows.map((row) => row.id));
  const featureOf = (id: string): string | null => (DISK_ROW_FEATURES[id] ?? null);
  for (let index = 0; index < rows.length; index += 1) { const row = rows[index]!; rows[index] = { ...row, feature: featureOf(row.id), minors_only: row.model_ids.some((id) => partDef(id)?.minorOnly === true) }; }
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
export function diskTotalsFor(plan: DiskPlan, selected: Iterable<string>, only?: "home" | "ai"): DiskTotals {
  return totals(plan.rows, new Set(selected), only);
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
    // The two parts apart, for an installer whose Home and AI folders sit on different disks.
    flat[`${tier.id}.home_required_free_bytes`] = diskTotalsFor(plan, plan.default_selected, "home").required_free_bytes;
    flat[`${tier.id}.ai_required_free_bytes`] = diskTotalsFor(plan, plan.default_selected, "ai").required_free_bytes;
  }
  return { measured_on: table.measured_on, margin_percent: table.margin_percent, headroom_warn_bytes: table.headroom_warn_bytes, gib_bytes: GIB, installer: flat, tiers };
}
