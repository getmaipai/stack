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
  CHATTERBOX_ENGINE, STACK_CHAT_MUSE_30B_MLX_MODEL, STACK_IMAGE_ERNIE_MODELS, STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_QWEN_MODELS, STACK_IMAGE_RESTORE_MODELS, STACK_IMAGE_TOOL_MODELS, STACK_IMAGE_ZIMAGE_MODELS, STACK_LIVEPORTRAIT_MODELS,
  STACK_MODELS, STACK_MUSIC_MODELS, STACK_MUSIC_WHISPER, STACK_MUSIC_MAX_MODELS, STACK_MUSIC_XL_MODELS, STACK_ALIGN_MODELS, STACK_SFX_MODELS, STACK_STEMS_MODELS, STACK_RECORDED_SPEECH_MODELS, STACK_VIDEO_MODELS, STACK_VIDEO_LTX25_MAX_MODELS, STACK_VIDEO_LTX25_MODELS, STACK_VIDEO_MASK_MODELS,
} from "@/lib/modelCatalog";
import { OMLX_OPTIONAL_TIERS } from "@/lib/chatEngines";
import { plannedPinsFor } from "@/lib/installPlan";
import type { CatalogModelLike } from "@/lib/modelStore";
import { IMAGE_FAMILIES } from "@/images/models";

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
/** The measured download of one engine environment (the components list sizes an install from the same table the wizard uses). */
export function engineDownloadBytes(key: string): number | null { return table.engines[key]?.download_bytes ?? null; }
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
  "engine:liveportrait": () => engineRow("engine:liveportrait", "liveportrait", "Talking pictures engine tools", "What making a companion's mouth and blink pictures runs on (about 1.5 GB, built on first use from pinned sources)."),
  "engine:video": () => engineRow("engine:video", "video-gen", "Video engine tools", "What making videos runs on."),
  "engine:video-ltx25": () => engineRow("engine:video-ltx25", "ltx25-gen", "LTX-2.5 video engine tools", "What the LTX-2.5 videos run on."),
  "engine:video-ltx25-max": () => engineRow("engine:video-ltx25-max", "ltx25-max-gen", "LTX-2.5 Max video engine tools", "What the LTX-2.5 Max videos run on."),
  "engine:video-mask": () => engineRow("engine:video-mask", "mask-gen", "SAM 2.1 mask tools", "What tracking a subject through a clip runs on."),
  "engine:music": () => engineRow("engine:music", "music-gen", "Music engine tools", "What making songs runs on."),
  "engine:sound-effects": () => engineRow("engine:sound-effects", "sfx-gen", "Sound effects engine tools", "What making sound effects runs on."),
  "engine:stems": () => engineRow("engine:stems", "stems", "Stem splitting tools", "What separating song stems runs on."),
  "engine:align": () => engineRow("engine:align", "align", "Lyric timing tools", "What timing a song's words runs on."),
  "engine:beats": () => engineRow("engine:beats", "beats", "Beat analysis tools", "What detecting beats and sections runs on."),
  "engine:voice-convert": () => engineRow("engine:voice-convert", "voice-convert", "Voice conversion tools", "What converting a singing voice runs on."),
  "engine:recorded-speech": () => engineRow("engine:recorded-speech", "recorded-speech", "Recorded speech tools", "What recorded speech rendering runs on."),
  "engine:chat-mlx": () => engineRow("engine:chat-mlx", "omlx", "Faster chat engine tools (oMLX)", "What the faster chat engine runs on. llama.cpp stays as the fallback."),
};
const PYTHON_ENGINES = ["engine:chat-mlx", "engine:voice", "engine:voice-better", "engine:pictures", "engine:image-tools", "engine:liveportrait", "engine:video", "engine:video-ltx25", "engine:video-ltx25-max", "engine:video-mask", "engine:music", "engine:sound-effects", "engine:stems", "engine:align", "engine:beats", "engine:voice-convert", "engine:recorded-speech"];

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
  const chat = plannedWhere((pin) => pin.role === "chat" && !projectors.has(pin.id));
  const bigChat = chat.find((pin) => !/qwen3-1\.7b/.test(pin.id)) ?? chat[0];
  const rows: DiskRow[] = [];
  rows.push({
    id: "home", label: "Home itself", note: "Home, the AI program that runs the models, and the space the install needs to build them.", kind: "home", need: "required", selectable: false,
    download_bytes: table.engines.home!.download_bytes, installed_bytes: table.engines.home!.installed_bytes, peak_temp_bytes: table.engines.home!.peak_temp_bytes, model_ids: [], engines: [], installed: false, basis: table.engines.home!.basis,
  });
  if (chat.length) {
    const starter = chat.length > 1 ? " A small starter chat AI (Qwen3 1.7B) comes first so you can talk while the big one downloads." : "";
    rows.push(modelRow({ id: "chat", label: `Chat AI (${chatName(bigChat!)})`, note: `The AI you talk to.${starter}`, need: "required", engines: chat.some((pin) => pin.engine === "omlx") ? ["engine:chat-mlx", "engine:python"] : [] }, chat));
  }
  // oMLX is an optional install on the tiers that have room (ENGINE-MLX-02: llama-server is the default everywhere).
  if (OMLX_OPTIONAL_TIERS.includes(tier.id)) rows.push(modelRow({ id: "chat-mlx", label: `Chat AI, Apple-chip build (${chatName(STACK_CHAT_MUSE_30B_MLX_MODEL)})`, note: "The chat AI as an MLX build, about 20 percent faster to answer but less reliable with tools in our tests. Optional; llama.cpp stays the default.", need: "optional", engines: ["engine:chat-mlx", "engine:python"] }, [STACK_CHAT_MUSE_30B_MLX_MODEL]));
  const reads = plannedWhere((pin) => projectors.has(pin.id) && pin.role !== "vision");
  if (reads.length) rows.push(modelRow({ id: "reads-pictures", label: "Reads pictures (projector)", note: "Lets the chat AI look at a picture you send it.", need: "recommended", engines: [] }, reads));
  // The picture reader (Qwen3-VL 4B and its projector) checks finished clips and pictures for safety when chat cannot read pictures (AIMODELS-VISION-01).
  const vision = plannedWhere((pin) => pin.role === "vision");
  if (vision.length) rows.push(modelRow({ id: "vision", label: "Picture reader (Qwen3-VL 4B)", note: "A small AI that describes what is in a picture. Home uses it to check finished clips and pictures for safety when the chat AI cannot read pictures.", need: "recommended", engines: [] }, vision));
  const judge = plannedWhere((pin) => pin.role === "judge");
  if (judge.length) rows.push(modelRow({ id: "judge", label: "Quick helper AI", note: "A second, smaller AI that double-checks answers.", need: "required", engines: [] }, judge));
  // The coding model rides the recommended setup but an admin can leave it out or remove it later (CODE-STACK-01).
  const coding = plannedWhere((pin) => pin.role === "coding");
  if (coding.length) rows.push(modelRow({ id: "coding", label: "Coding AI (Qwen3.8 27B)", note: "Writes code for the coding tools you connect. It loads only while someone is coding. On a Mac with an M3 chip or newer it includes a 3.8 GB helper that makes it about four times faster. Skip it if your household does not want coding.", need: "recommended", engines: [] }, coding));
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
  const look = STACK_IMAGE_TOOL_MODELS.filter((pin) => pin.component === "tool-look");
  if (look.length) rows.push(modelRow({ id: "tool-look", label: "Look at pictures", note: "Name household objects, wall colour and light. Runs only when Home sends a picture.", need: "optional", engines: ["engine:image-tools", "engine:python"] }, look));
  if (!tier.notAvailable.includes("image")) rows.push(modelRow({ id: TALKING_PICTURES_ROW, label: "Talking pictures (LivePortrait)", note: "Makes the mouth and blink pictures a talking companion plays while it speaks, and what Make needs to build a companion. MIT licence; about 0.6 GB of model files plus a 1.5 GB engine, built on this computer. Mac with Apple silicon only.", need: "recommended", engines: ["engine:liveportrait", "engine:python"] }, STACK_LIVEPORTRAIT_MODELS));
  if (!tier.notAvailable.includes("image")) {
    rows.push(modelRow({ id: "pictures", label: "Change pictures (FLUX.2 Klein)", note: "Needed. Edits the pictures you already have, and makes new ones when ERNIE is not installed.", need: "required", engines: ["engine:pictures", "engine:python"] }, STACK_IMAGE_KLEIN_MODELS));
    if (IMAGE_FAMILIES["ernie-image-turbo"].tiers.some((supportedTier) => supportedTier === tier.id)) rows.push(modelRow({ id: "pictures-ernie", label: "Make pictures (ERNIE)", note: "Recommended. Draws words in pictures correctly. Makes new pictures from a sentence.", need: "recommended", engines: ["engine:pictures", "engine:python"] }, STACK_IMAGE_ERNIE_MODELS));
    if (TIER_ORDER.indexOf(tier.id) >= TIER_ORDER.indexOf("p128")) rows.push(modelRow({ id: "pictures-zimage", label: "More picture styles (Z-Image Turbo)", note: "A second picture maker with a different look. Optional.", need: "optional", engines: ["engine:pictures", "engine:python"] }, STACK_IMAGE_ZIMAGE_MODELS));
    if (TIER_ORDER.indexOf(tier.id) >= TIER_ORDER.indexOf("p128")) rows.push(modelRow({ id: "pictures-qwen", label: "Best pictures (Qwen-Image)", note: "The best picture maker, used for Max pictures. Clear words and fine detail. A large download. Optional.", need: "optional", engines: ["engine:pictures", "engine:python"] }, STACK_IMAGE_QWEN_MODELS));
  }
  // MAKE-CLEARER-2026-11-13: the Best level of Make clearer for pictures. Optional; its 12 GB peak is recommended only from the 64 GB tier up.
  if (!tier.notAvailable.includes("image") && TIER_ORDER.indexOf(tier.id) >= TIER_ORDER.indexOf("p64")) rows.push(modelRow({ id: "pictures-clearer", label: "Clearer pictures, best quality (SeedVR2)", note: "The most careful repair for old or soft pictures, used by Make clearer at its Best level. It redraws fine detail, so Home checks faces and keeps the original if one changes. Optional, about 7.3 GB, Apache-2.0.", need: "optional", engines: ["engine:pictures", "engine:python"] }, STACK_IMAGE_RESTORE_MODELS));
  if (!tier.notAvailable.includes("video")) rows.push(modelRow({ id: "video", label: "Make videos (Wan2.2)", note: "Recommended. Makes a short clip from a sentence or a picture.", need: "recommended", engines: ["engine:video", "engine:python"] }, STACK_VIDEO_MODELS));
  if (!tier.notAvailable.includes("music")) rows.push(modelRow({ id: "music", label: "Make music (ACE-Step 1.5)", note: "Makes and changes songs in chat. Optional.", need: "optional", engines: ["engine:music", "engine:python"] }, STACK_MUSIC_MODELS));
  if (!tier.notAvailable.includes("music")) rows.push(modelRow({ id: "music-transcribe", label: "Check sung words (Whisper)", note: "Transcribes finished songs for Home to check. Optional, about 1.6 GB.", need: "optional", engines: ["engine:music", "engine:python"] }, [STACK_MUSIC_WHISPER]));
  if (!tier.notAvailable.includes("music") && TIER_ORDER.indexOf(tier.id) >= TIER_ORDER.indexOf("p128")) rows.push(modelRow({ id: "music-boost", label: "Clearer songs (ACE-Step XL Turbo)", note: "A larger song model for Boost quality, with clearer voices. Optional, about 10 GB.", need: "optional", engines: ["engine:music", "engine:python"] }, STACK_MUSIC_XL_MODELS));
  if (!tier.notAvailable.includes("music") && TIER_ORDER.indexOf(tier.id) >= TIER_ORDER.indexOf("p128")) rows.push(modelRow({ id: "music-max", label: "Best songs (ACE-Step XL SFT)", note: "The best song model and its larger planning model, for Max quality. Optional, about 18 GB.", need: "optional", engines: ["engine:music", "engine:python"] }, STACK_MUSIC_MAX_MODELS));
  if (!tier.notAvailable.includes("video") && TIER_ORDER.indexOf(tier.id) >= TIER_ORDER.indexOf("p128")) rows.push(modelRow({ id: "video-ltx25", label: "Videos with sound (LTX-2.5)", note: "Clips with a sound track and spoken words, up to 10 seconds. Optional, about 38 GB; it needs the maker's licence accepted once during setup.", need: "optional", engines: ["engine:video-ltx25", "engine:python"] }, STACK_VIDEO_LTX25_MODELS));
  if (!tier.notAvailable.includes("video") && TIER_ORDER.indexOf(tier.id) >= TIER_ORDER.indexOf("p128")) rows.push(modelRow({ id: "video-ltx25-max", label: "Best videos with sound (LTX-2.5 Max)", note: "Larger 1024 by 576 clips with a sound track and spoken words, up to 10 seconds. Optional, about 71 GB; it needs the maker's licence accepted once during setup.", need: "optional", engines: ["engine:video-ltx25-max", "engine:python"] }, STACK_VIDEO_LTX25_MAX_MODELS));
  if (!tier.notAvailable.includes("video") && TIER_ORDER.indexOf(tier.id) >= TIER_ORDER.indexOf("p64")) rows.push(modelRow({ id: "video-mask", label: "Subject masks on clips (SAM 2.1)", note: "Optional background removal and cutouts for clips. Apache-2.0; 4.9 GB measured running peak.", need: "optional", engines: ["engine:video-mask", "engine:python"] }, STACK_VIDEO_MASK_MODELS));
  // MP-07: sound effects, optional, on every tier with 32 GB or more (about 6.5 GB while a sound is made); the maker's licence is accepted at install.
  if (TIER_ORDER.indexOf(tier.id) >= TIER_ORDER.indexOf("p32")) rows.push(modelRow({ id: "sound-effects", label: "Make sound effects (Stable Audio 3 Small-SFX)", note: "Makes short sound effects and ambience from a sentence. Optional, about 3.5 GB. Stability AI Community License and Gemma Terms of Use, accepted once when it installs.", need: "optional", engines: ["engine:sound-effects", "engine:python"] }, STACK_SFX_MODELS));
  rows.push(modelRow({ id: "stems", label: "Split songs into stems (HTDemucs)", note: "Separates songs made in Home into vocals, drums, bass and other. Recommended, about 0.3 GB.", need: "recommended", engines: ["engine:stems", "engine:python"] }, [STACK_STEMS_MODELS[0]!]));
  rows.push(modelRow({ id: "stems-ft", label: "Finer stem splitter (HTDemucs fine-tuned)", note: "An optional four model package for finer stem separation.", need: "optional", engines: ["engine:stems", "engine:python"] }, [STACK_STEMS_MODELS[1]!]));
  rows.push(modelRow({ id: "stems-6s", label: "Six-part stem splitter (guitar and piano)", note: "An optional model that separates guitar and piano too.", need: "optional", engines: ["engine:stems", "engine:python"] }, [STACK_STEMS_MODELS[2]!]));
  rows.push(modelRow({ id: "align", label: "Time song lyrics (MMS aligner)", note: "Finds when each word of a song's lyrics is sung, for the lyrics display. Optional, about 1.3 GB.", need: "optional", engines: ["engine:align", "engine:python"] }, STACK_ALIGN_MODELS));
  rows.push(modelRow({ id: "voice-convert", label: "Change the singing voice (SoulX-Singer)", note: "Converts a vocal toward a reference voice. Optional, about 3 GB.", need: "optional", engines: ["engine:voice-convert", "engine:python"] }, STACK_MODELS.filter((pin) => pin.component === "voice-convert")));
  rows.push(modelRow({ id: "recorded-speech", label: "Recorded speech (Fish Audio Drama 3)", note: "Makes a finished voice recording from typed words, including dialogue. It also lets the Chatterbox voice whisper. Recommended with Chatterbox, about 24 GB; needs a 64 GB or larger computer. Skip it and the voice speaks normally when asked to whisper.", need: "recommended", engines: ["engine:recorded-speech", "engine:python"] }, STACK_RECORDED_SPEECH_MODELS));
  // ffmpeg and ffprobe: one pinned archive (media/pins.ts), required because songs, voice shifting and clips cut with it. No model pins.
  const ffmpeg = table.engines.ffmpeg!;
  rows.push({ id: "ffmpeg", label: "Audio and video tools (ffmpeg)", note: "Cuts, mixes and changes sound and video. GPL 3 or later.", kind: "model", need: "required", selectable: false, download_bytes: ffmpeg.download_bytes, installed_bytes: ffmpeg.installed_bytes, peak_temp_bytes: ffmpeg.peak_temp_bytes, model_ids: [], engines: [], installed: false, basis: ffmpeg.basis });
  rows.push({ id: "shazam-signature", label: "Song signature tool (shazamio-core)", note: "Makes a small signature from a few seconds of music so Home can name the song. MIT; audio stays on this computer.", kind: "model", need: "optional", selectable: true, download_bytes: 1_700_000, installed_bytes: 1_700_000, peak_temp_bytes: 0, model_ids: [], engines: [], installed: false, basis: "pins" });
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
