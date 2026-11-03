// VIDEO-GEN-03: the household LoRA library, Stack side. One directory of
// `.safetensors` files and one manifest, under data/video/loras. A record
// holds what Home needs to decide who may use a file and what the Stack needs
// to apply it: the file's sha256 and size, its source and licence, the base
// model it was made for, a default strength, trigger words, who added it, and
// a classification, `all-ages` or `adult-only`.
//
// What the Stack decides and what it does not. It decides facts about the file:
// whether it is a LoRA for the Wan2.2 5B model (read from the tensor shapes in
// the safetensors header, never from a name), its hash, its rank, and whether
// its own metadata names adult content (then it cannot be all-ages) or names a
// minor in a sexual context (then it is refused outright, the absolute line
// that no setting lifts). It does not decide who may use a file: Home does, per
// age band and surface, and a job names the LoRAs it is allowed to apply. As a
// second lock a job also states its audience; a job whose audience is not
// `adult` can never apply an `adult-only` file, whatever list it sends.
//
// The word checks below are a tripwire over file metadata, not a judgement of
// the pictures a LoRA makes. They never refuse a file for naming a real person
// or a public figure (MODELS-CENSOR-05, owner ruling 2026-11-02). They are listed in one place so a rule change is
// one edit, and a file with no metadata is `adult-only` unless the importer
// says otherwise (uncertain means adult-only).
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { sha256OfFile } from "@/lib/fileHash";
import { namesRealPerson } from "@/lib/media/loraLibrary";

export const LORA_BASE_MODEL = "wan2.2-ti2v-5b";
/** VIDEO-LTX-01: the two bases a LoRA can be made for: Quick's Wan2.2 5B, Detailed's LTX-2.3. */
export const LORA_BASE_LTX = "ltx-2.3";
/** VIDEO-LORA-05: the third base, the LTX-2.5 engine (Standard, Boost and Max). Its tensors read exactly like LTX-2.3's (see `detectLoraBase`). */
export const LORA_BASE_LTX25 = "ltx-2.5";
export const LORA_BASE_MODELS = [LORA_BASE_MODEL, LORA_BASE_LTX, LORA_BASE_LTX25] as const;
export type LoraBase = typeof LORA_BASE_MODELS[number];
export const LORA_CLASSES = ["all-ages", "adult-only"] as const;
export type LoraClass = typeof LORA_CLASSES[number];
export type Audience = "all-ages" | "adult";
export const MAX_LORAS_PER_JOB = 4;
export const MAX_LORA_STRENGTH = 2;
/** 4 GB (VIDEO-LORA-05; Max-sized community LoRAs reach 2.6 GB). */
export const MAX_LORA_BYTES = 4 * 1_073_741_824;
const MAX_HEADER_BYTES = 64 * 1_048_576;

export interface LoraRecord {
  id: string;
  name: string;
  file: string;
  sha256: string;
  bytes: number;
  mtime_ms: number;
  rank: number;
  modules: number;
  base_model: LoraBase;
  licence: string;
  /** "free" licences import without a question; anything else needs the adder's acknowledgement, which is recorded. */
  licence_class: "free" | "acknowledged";
  source_url: string | null;
  classification: LoraClass;
  /** Why the file is adult-only when the importer asked for all-ages (the file's own metadata names adult content). */
  classification_note: string | null;
  strength_default: number;
  trigger_words: string[];
  added_by: string | null;
  added_at: string;
}

export class LoraError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

const FREE_LICENCES = new Set(["apache-2.0", "mit", "cc0-1.0", "bsd-2-clause", "bsd-3-clause", "unlicense", "isc", "cc-by-4.0"]);
export function licenceClass(licence: string): "free" | "acknowledged" { return FREE_LICENCES.has(licence.trim().toLowerCase()) ? "free" : "acknowledged"; }

/** Words in a file's own metadata that make it adult-only. */
const ADULT_WORDS = ["nsfw", "explicit", "nude", "nudity", "naked", "porn", "porno", "pornographic", "hentai", "sex", "sexual", "erotic", "lewd", "genitals", "xxx", "adult", "18+", "topless", "fetish", "bdsm", "cum", "boobs", "nipples", "pussy", "dick", "blowjob"];
/** Words that, beside any adult word, or alone for the first two, mean the file is refused. */
const MINOR_ALONE = ["loli", "lolicon", "shota", "shotacon"];
const MINOR_WORDS = ["child", "children", "kid", "kids", "minor", "underage", "preteen", "toddler", "schoolgirl", "schoolboy", "teen", "teenage", "young girl", "young boy", "little girl", "little boy"];
const wordRegex = (words: string[]) => new RegExp(`(^|[^a-z0-9])(${words.map((word) => word.replace(/[+]/g, "\\+")).join("|")})([^a-z0-9]|$)`, "i");
const ADULT_RE = wordRegex(ADULT_WORDS);
const MINOR_ALONE_RE = wordRegex(MINOR_ALONE);
const MINOR_RE = wordRegex(MINOR_WORDS);

/** Everything a person or a trainer wrote about the file, as one string to scan: metadata values, tag names, the name, the file name, the trigger words. */
function describedAs(parts: Array<string | null | undefined>, metadata: Record<string, unknown> | undefined): string {
  const strings: string[] = parts.filter((part): part is string => !!part);
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof value === "string") {
      const text = value.length > 20_000 ? value.slice(0, 20_000) : value;
      strings.push(text);
      if (text.startsWith("{") || text.startsWith("[")) { try { visit(JSON.parse(text), depth + 1); } catch { /* plain text */ } }
    } else if (Array.isArray(value)) value.slice(0, 500).forEach((item) => visit(item, depth + 1));
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value).slice(0, 2000)) { strings.push(key); visit(item, depth + 1); }
  };
  if (metadata) visit(metadata, 0);
  return strings.join("\n").replace(/[_\-.,/]+/g, " ");
}

export interface SafetensorsInfo { rank: number; modules: number; dims: number[]; metadata: Record<string, unknown> | undefined; /** Tensors named the way LTX transformers name them (transformer_blocks), and the way Wan ones do (blocks, self_attn). */ ltxKeys?: number; wanKeys?: number; }

export interface SafetensorsEntry { dtype?: string; shape?: number[]; data_offsets?: [number, number] }
/** The parsed header of a safetensors file (the first 8 bytes say how long the JSON is), checked to be whole; throws a LoraError that says what to do. */
export function readSafetensorsHeader(path: string): { header: Record<string, SafetensorsEntry | Record<string, unknown>>; metadata: Record<string, unknown> | undefined; entries: Array<[string, SafetensorsEntry]> } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const lengthBytes = Buffer.alloc(8);
    if (size < 16 || readSync(fd, lengthBytes, 0, 8, 0) !== 8) throw new LoraError("not_safetensors", "That file is not a LoRA: use a .safetensors file.", 422);
    const headerLength = Number(lengthBytes.readBigUInt64LE(0));
    if (!Number.isSafeInteger(headerLength) || headerLength <= 2 || headerLength > MAX_HEADER_BYTES || 8 + headerLength > size) throw new LoraError("not_safetensors", "That file is not a LoRA: use a .safetensors file.", 422);
    const raw = Buffer.alloc(headerLength);
    readSync(fd, raw, 0, headerLength, 8);
    let header: Record<string, SafetensorsEntry | Record<string, unknown>>;
    try { header = JSON.parse(raw.toString("utf8")); } catch { throw new LoraError("not_safetensors", "That file is not a LoRA: use a .safetensors file.", 422); }
    const dataLength = size - 8 - headerLength;
    const entries: Array<[string, SafetensorsEntry]> = [];
    for (const [key, entry] of Object.entries(header)) {
      if (key === "__metadata__") continue;
      const tensor = entry as SafetensorsEntry;
      if (!tensor.shape || !tensor.data_offsets || tensor.data_offsets[1] > dataLength) throw new LoraError("not_safetensors", "That file looks cut short or damaged. Download it again.", 422);
      entries.push([key, tensor]);
    }
    return { header, metadata: header.__metadata__ as Record<string, unknown> | undefined, entries };
  } finally { closeSync(fd); }
}

/** Reads a safetensors header and what it says about LoRA tensors; throws a LoraError that says what to do. */
export function readLoraHeader(path: string): SafetensorsInfo {
  const { metadata, entries } = readSafetensorsHeader(path);
  const dims = new Set<number>();
  let rank = 0; let modules = 0; let ltxKeys = 0; let wanKeys = 0;
  for (const [key, tensor] of entries) {
    // Dotted (ComfyUI, diffusers) and underscored (kohya `lora_unet_transformer_blocks_0_attn1_to_k`) layer names both say LTX; the key check, not this, decides whether the runtime can read them.
    if (/transformer_blocks[._]\d+[._](?:audio_)?attn\d|transformer_blocks[._]\d+[._]ff[._]/.test(key)) ltxKeys += 1;
    else if (/(?:^|\.)blocks\.\d+\.(?:self_attn|cross_attn|ffn)/.test(key)) wanKeys += 1;
    const shape = tensor.shape!;
    const down = /\.lora_(?:A|down)\.weight$/.test(key);
    const up = /\.lora_(?:B|up)\.weight$/.test(key);
    if (down && shape.length === 2) { modules += 1; rank = Math.max(rank, shape[0]!); dims.add(shape[1]!); }
    if (up && shape.length === 2) dims.add(shape[0]!);
  }
  return { rank, modules, dims: [...dims], metadata, ltxKeys, wanKeys };
}

/** Throws unless the tensors fit the Wan2.2 5B transformer (width 3072). A 14B model is 5120 wide and a 1.3B model 1536. */
export function assertWan5bLora(info: SafetensorsInfo): void {
  if (info.modules === 0) throw new LoraError("not_a_lora", "That file has no LoRA weights in a form this video model reads (it needs lora_A and lora_B, or lora_down and lora_up, tensors).", 422);
  if (info.dims.includes(5120) || info.dims.includes(1536) || !info.dims.includes(3072)) throw new LoraError("wrong_base_model", "This LoRA was made for a different video model. Only LoRAs made for Wan2.2 TI2V-5B work here.", 422);
}

/**
 * Which model a LoRA was made for. The tensors say the FAMILY: LTX transformers are 4096 wide with transformer_blocks keys; Wan2.2 5B is
 * 3072 wide with blocks keys; a file that fits neither throws wrong_base_model. They cannot say the LTX VERSION: measured 2026-11-02 on real
 * files, an LTX-2.5 LoRA (DigitalByte XPLDV) and an LTX-2.3 LoRA (TheBurgstall googlyeyes) have the same key layout (`diffusion_model.transformer_blocks.N.attnN.to_k|to_q|to_v|to_out.0`),
 * the same width (4096), the same 48 blocks and the same rank and shape rules, and the 2.3 file loads on the 2.5 pack and does nothing. So the
 * version is DECLARED by whoever adds the file (`declared`: Home, from the source's own base field or an admin), and the file can only
 * contradict it: a trainer's `ss_ltx_version` that names another version, or a family that is not LTX, is refused with wrong_base_model.
 * With nothing declared an LTX file reads as LTX-2.3 (the behaviour before LTX-2.5 LoRAs existed), which only ever blocks use on an
 * LTX-2.5 clip; it never lets a file run where it was not declared.
 */
export function detectLoraBase(info: SafetensorsInfo, declared?: LoraBase | null): LoraBase {
  if (info.modules === 0) throw new LoraError("not_a_lora", "That file has no LoRA weights in a form this video model reads (it needs lora_A and lora_B, or lora_down and lora_up, tensors).", 422);
  if ((info.ltxKeys ?? 0) > 0 && (info.wanKeys ?? 0) === 0 && info.dims.includes(4096)) {
    // A trainer that writes the LTX version into the file says which one it was made for; a 2.0 file is neither a 2.3 nor a 2.5 LoRA.
    const version = String(info.metadata?.ss_ltx_version ?? "");
    const named: LoraBase | null = version.startsWith("2.3") ? LORA_BASE_LTX : version.startsWith("2.5") ? LORA_BASE_LTX25 : null;
    if (version && !named) throw new LoraError("wrong_base_model", `This LoRA was made for LTX ${version}, and these videos use LTX 2.3 (Detailed) or LTX 2.5. Pick a LoRA made for one of those.`, 422);
    if (declared && declared !== LORA_BASE_LTX && declared !== LORA_BASE_LTX25) throw new LoraError("wrong_base_model", "This LoRA is an LTX LoRA, but it was said to be made for a different video model. Say which LTX version it was made for (2.3 or 2.5).", 422);
    if (declared && named && declared !== named) throw new LoraError("wrong_base_model", `This LoRA's own description says it was made for LTX ${version}, not ${declared === LORA_BASE_LTX25 ? "2.5" : "2.3"}. Pick the version the file names, or a different file.`, 422);
    return declared ?? named ?? LORA_BASE_LTX;
  }
  if ((info.wanKeys ?? 0) >= 0 && (info.ltxKeys ?? 0) === 0) {
    assertWan5bLora(info);
    if (declared && declared !== LORA_BASE_MODEL) throw new LoraError("wrong_base_model", "This LoRA was made for Wan2.2 TI2V-5B (Quick), not the video model it was said to be for.", 422);
    return LORA_BASE_MODEL;
  }
  throw new LoraError("wrong_base_model", "This LoRA was made for a different video model. Only LoRAs made for Wan2.2 TI2V-5B (Quick), LTX-2.3 (Detailed) or LTX-2.5 work here.", 422);
}

// ---- VIDEO-LORA-05: what the LTX runtimes can actually map ----
//
// The ltx-2-mlx runtime (the 0.18.0 release and the pinned fork) fuses or attaches a LoRA by matching `<module>.lora_A.weight` and
// `<module>.lora_B.weight` against the transformer's `<module>.weight`, after one rename table (LTXV_LORA_COMFY_RENAMING_MAP). A key it cannot
// match is IGNORED WITHOUT AN ERROR: a kohya file (`lora_down`/`lora_up`, `lora_unet_...`) loads, changes no weight and makes the clip
// without the style (measured 2026-11-02, ~/video-bench/loras/BENCH.md). The Stack therefore reads the header itself and refuses a file that
// would be a silent no-op, before a job exists. The rename table below mirrors the runtime's; the tests check it against real files.
const LTX_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["diffusion_model.", ""], [".to_out.0.", ".to_out."], [".ff.net.0.proj.", ".ff.proj_in."], [".ff.net.2.", ".ff.proj_out."], [".linear_1.", ".linear1."], [".linear_2.", ".linear2."], ["audio_ff.net.0.proj.", "audio_ff.proj_in."], ["audio_ff.net.2.", "audio_ff.proj_out."],
];
/** The module a LoRA tensor key targets, in the transformer's own naming, or null when the key is not a ComfyUI-style `lora_A`/`lora_B` weight. */
export function ltxLoraModule(key: string): { module: string; side: "A" | "B" } | null {
  const found = /^(.*)\.lora_([AB])\.weight$/.exec(key);
  if (!found) return null;
  let path = `${found[1]}.`;
  for (const [from, to] of LTX_RENAMES) if (path.includes(from)) path = path.split(from).join(to);
  return { module: path.slice(0, -1), side: found[2] as "A" | "B" };
}
export interface LtxLoraKeys {
  /** Modules with both a lora_A and a lora_B tensor in the form the runtime reads. */
  pairs: number;
  /** Tensors in kohya form (`lora_down` / `lora_up`), which the runtime does not read. */
  kohya: number;
  /** Rank (the smallest side of a pair's A) and the module shapes: module -> { in, out }. */
  modules: Map<string, { in: number; out: number; rank: number }>;
}
/** Reads a LoRA file's header and says which of its tensors the LTX runtimes can map (no weights are read). */
export function inspectLtxLoraKeys(path: string): LtxLoraKeys {
  const { entries } = readSafetensorsHeader(path);
  const a = new Map<string, number[]>(); const b = new Map<string, number[]>();
  let kohya = 0;
  for (const [key, tensor] of entries) {
    if (/\.lora_(?:down|up)\.weight$/.test(key)) { kohya += 1; continue; }
    const target = ltxLoraModule(key);
    if (!target || tensor.shape!.length !== 2) continue;
    (target.side === "A" ? a : b).set(target.module, tensor.shape!);
  }
  const modules = new Map<string, { in: number; out: number; rank: number }>();
  for (const [module, down] of a) { const up = b.get(module); if (up && up[1] === down[0]) modules.set(module, { in: down[1]!, out: up[0]!, rank: down[0]! }); }
  return { pairs: modules.size, kohya, modules };
}
/** Throws `lora_keys_unsupported` for a file the LTX runtimes would run as a silent no-op. `name` is how the person knows the file. */
export function assertLtxLoraKeys(keys: LtxLoraKeys, name = "This LoRA"): void {
  if (keys.pairs > 0) return;
  if (keys.kohya > 0) throw new LoraError("lora_keys_unsupported", `${name} uses the kohya tensor names (lora_down and lora_up), which the video model does not read, so it would change nothing. Use a copy saved for ComfyUI or diffusers (tensor names ending in lora_A.weight and lora_B.weight, under diffusion_model), or pick another style.`, 422);
  throw new LoraError("lora_keys_unsupported", `${name} has no tensors the video model can use (it needs diffusion_model...lora_A.weight and lora_B.weight pairs), so it would change nothing. Pick a LoRA made for LTX-2.3 or LTX-2.5 and saved for ComfyUI, or use another style.`, 422);
}
/** How many of a LoRA's modules fit this transformer, from the pack's own header (name and, where it can be told, the in/out size). */
export function matchLtxLoraToPack(keys: LtxLoraKeys, packTransformerPath: string): { matched: number; total: number; shapeMismatch: number } {
  const { entries } = readSafetensorsHeader(packTransformerPath);
  const weights = new Map<string, { shape: number[]; dtype?: string; scales?: number[] }>();
  for (const [key, tensor] of entries) {
    const name = key.startsWith("transformer.") ? key.slice("transformer.".length) : key;
    if (name.endsWith(".weight")) weights.set(name.slice(0, -".weight".length), { shape: tensor.shape!, dtype: tensor.dtype });
    else if (name.endsWith(".scales")) { const target = weights.get(name.slice(0, -".scales".length)); if (target) target.scales = tensor.shape!; else weights.set(name.slice(0, -".scales".length), { shape: [], scales: tensor.shape! }); }
  }
  // A scales tensor can come before its weight in the header; fill both orders.
  for (const [key, tensor] of entries) {
    const name = key.startsWith("transformer.") ? key.slice("transformer.".length) : key;
    if (name.endsWith(".scales")) { const target = weights.get(name.slice(0, -".scales".length)); if (target) target.scales = tensor.shape!; }
  }
  let matched = 0; let shapeMismatch = 0;
  for (const [module, lora] of keys.modules) {
    const target = weights.get(module);
    if (!target || target.shape.length !== 2) continue;
    // A quantized weight is packed (U32): its true input size is the scales' group count times the group size (32, 64 or 128).
    const inOk = target.dtype === "U32" && target.scales ? [32, 64, 128].some((group) => target.scales![1]! * group === lora.in) : target.shape[1] === lora.in;
    if (target.shape[0] === lora.out && inOk) matched += 1; else shapeMismatch += 1;
  }
  return { matched, total: keys.modules.size, shapeMismatch };
}

export interface ImportInput {
  /** The file's bytes on this computer (a path the Stack can read). */
  path: string;
  name: string;
  licence: string;
  licenceAcknowledged?: boolean;
  sourceUrl?: string | null;
  classification?: LoraClass;
  strengthDefault?: number;
  triggerWords?: string[];
  addedBy?: string | null;
  /** The base the adder says the file was made for (an LTX file's version cannot be read from its tensors: see detectLoraBase). */
  declaredBase?: LoraBase | null;
}

function libraryDir(): string { return join(dataDir, "video", "loras"); }
function manifestPath(): string { return join(libraryDir(), "manifest.json"); }
function loraFile(id: string): string { return join(libraryDir(), `${id}.safetensors`); }
const ID_RE = /^lora-[0-9a-f]{16}$/;
export const isLoraId = (value: string): boolean => ID_RE.test(value);

function readManifest(): LoraRecord[] {
  try { const parsed = JSON.parse(readFileSync(manifestPath(), "utf8")) as { loras?: LoraRecord[] }; return Array.isArray(parsed.loras) ? parsed.loras.map((record) => ({ ...record, base_model: record.base_model ?? LORA_BASE_MODEL })) : []; } catch { return []; }
}
function writeManifest(records: LoraRecord[]): void {
  mkdirSync(libraryDir(), { recursive: true, mode: 0o700 });
  const target = manifestPath();
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ loras: records }, null, 1), { mode: 0o600 });
  renameSync(temp, target);
}

let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T> | T): Promise<T> {
  const next = lock.then(work, work);
  lock = next.catch(() => {});
  return next;
}

export function listLoras(): LoraRecord[] { return readManifest().map((record) => ({ ...record })); }
export function getLora(id: string): LoraRecord | null { return readManifest().find((record) => record.id === id) ?? null; }
export function loraPath(id: string): string { return loraFile(id); }

function cleanWords(words: string[] | undefined): string[] {
  return (words ?? []).map((word) => word.trim()).filter((word) => word.length > 0 && word.length <= 200).slice(0, 20);
}

/** Checks a file's own words: refuses a minor in a sexual context; says
 * whether its metadata names adult content. */
function scanWords(text: string): { refuse: boolean; adult: boolean } {
  const adult = ADULT_RE.test(text);
  const refuse = MINOR_ALONE_RE.test(text) || (adult && MINOR_RE.test(text));
  return { refuse, adult };
}

export async function importLora(input: ImportInput): Promise<LoraRecord> {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new LoraError("bad_name", "Give the LoRA a name of 1 to 120 characters.", 422);
  const licence = input.licence.trim();
  if (!licence || licence.length > 200) throw new LoraError("licence_required", "Say what licence the LoRA is under (write \"unknown\" if you do not know).", 422);
  const klass = licenceClass(licence);
  if (klass === "acknowledged" && input.licenceAcknowledged !== true) throw new LoraError("licence_acknowledgement_required", `This LoRA's licence (${licence}) is not one of the open ones. Confirm that you have read it and may use the file at home, then add it again.`, 422);
  if (input.strengthDefault !== undefined && !(input.strengthDefault >= 0 && input.strengthDefault <= MAX_LORA_STRENGTH)) throw new LoraError("bad_strength", `The default strength must be between 0 and ${MAX_LORA_STRENGTH}.`, 422);
  if (input.classification !== undefined && !LORA_CLASSES.includes(input.classification)) throw new LoraError("bad_classification", "The classification is all-ages or adult-only.", 422);
  const stat = statSync(input.path);
  if (!stat.isFile() || stat.size === 0) throw new LoraError("not_safetensors", "That is not a file.", 422);
  if (stat.size > MAX_LORA_BYTES) throw new LoraError("too_large", `That file is larger than ${MAX_LORA_BYTES / 1_073_741_824} GB, the most a LoRA can be here.`, 413);
  const info = readLoraHeader(input.path);
  if (input.declaredBase !== undefined && input.declaredBase !== null && !LORA_BASE_MODELS.includes(input.declaredBase)) throw new LoraError("bad_base_model", `The base model is one of ${LORA_BASE_MODELS.join(", ")}.`, 422);
  const base = detectLoraBase(info, input.declaredBase);
  if (base === LORA_BASE_LTX25) assertLtxLoraKeys(inspectLtxLoraKeys(input.path), `"${name}"`);
  const triggerWords = cleanWords(input.triggerWords);
  const text = describedAs([name, ...triggerWords, input.path.split("/").pop(), input.sourceUrl], info.metadata);
  const words = scanWords(text);
  if (words.refuse) throw new LoraError("lora_refused", "This LoRA's own description names a child or a minor in a sexual context. It cannot be added; no setting allows that.", 422);
  const sha256 = await sha256OfFile(input.path);
  const id = `lora-${sha256.slice(0, 16)}`;
  return exclusive(() => {
    const records = readManifest();
    if (records.some((record) => record.id === id)) throw new LoraError("already_added", "This LoRA is already in the library.", 409);
    mkdirSync(libraryDir(), { recursive: true, mode: 0o700 });
    const target = loraFile(id);
    const temp = `${target}.${process.pid}.part`;
    copyFileSync(input.path, temp);
    renameSync(temp, target);
    const asked: LoraClass = input.classification ?? "adult-only";
    const classification: LoraClass = words.adult || namesRealPerson(text) ? "adult-only" : asked;
    const record: LoraRecord = {
      id, name, file: `${id}.safetensors`, sha256, bytes: stat.size, mtime_ms: Math.floor(statSync(target).mtimeMs), rank: info.rank, modules: info.modules, base_model: base,
      licence, licence_class: klass, source_url: input.sourceUrl?.slice(0, 2000) ?? null, classification,
      classification_note: words.adult && asked === "all-ages" ? "The file's own description names adult content, so it is adult-only." : null,
      strength_default: input.strengthDefault ?? 1, trigger_words: triggerWords, added_by: input.addedBy?.slice(0, 200) ?? null, added_at: new Date().toISOString(),
    };
    writeManifest([...records, record]);
    return record;
  });
}

export interface LoraPatch { name?: string; classification?: LoraClass; strengthDefault?: number; triggerWords?: string[]; sourceUrl?: string | null; /** Moves an LTX file between LTX-2.3 and LTX-2.5 (the file is read again and may contradict it). */ baseModel?: LoraBase; }

/** Edits a record. The Stack keeps the one fact it can check: a file whose
 * metadata names adult content cannot be set all-ages. Who may change the
 * class is Home's rule (only an adult can move a file to all-ages). */
export function updateLora(id: string, patch: LoraPatch): Promise<LoraRecord> {
  return exclusive(() => {
    const records = readManifest();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) throw new LoraError("unknown_lora", "No such LoRA in the library.", 404);
    const current = records[index]!;
    if (patch.strengthDefault !== undefined && !(patch.strengthDefault >= 0 && patch.strengthDefault <= MAX_LORA_STRENGTH)) throw new LoraError("bad_strength", `The default strength must be between 0 and ${MAX_LORA_STRENGTH}.`, 422);
    if (patch.classification !== undefined && !LORA_CLASSES.includes(patch.classification)) throw new LoraError("bad_classification", "The classification is all-ages or adult-only.", 422);
    const next: LoraRecord = { ...current };
    if (patch.name !== undefined) { const name = patch.name.trim(); if (!name || name.length > 120) throw new LoraError("bad_name", "Give the LoRA a name of 1 to 120 characters.", 422); next.name = name; }
    if (patch.strengthDefault !== undefined) next.strength_default = patch.strengthDefault;
    if (patch.triggerWords !== undefined) next.trigger_words = cleanWords(patch.triggerWords);
    if (patch.sourceUrl !== undefined) next.source_url = patch.sourceUrl?.slice(0, 2000) ?? null;
    if (patch.baseModel !== undefined) {
      if (!LORA_BASE_MODELS.includes(patch.baseModel)) throw new LoraError("bad_base_model", `The base model is one of ${LORA_BASE_MODELS.join(", ")}.`, 422);
      if (patch.baseModel !== current.base_model) {
        const info = readLoraHeader(loraFile(id));
        next.base_model = detectLoraBase(info, patch.baseModel);
        if (next.base_model === LORA_BASE_LTX25) assertLtxLoraKeys(inspectLtxLoraKeys(loraFile(id)), `"${next.name}"`);
      }
    }
    if (patch.classification !== undefined) {
      if (patch.classification === "all-ages") {
        const info = readLoraHeader(loraFile(id));
        const words = scanWords(describedAs([next.name, ...next.trigger_words, next.source_url], info.metadata));
        if (words.adult) throw new LoraError("classification_locked", "This file's own description names adult content, so it stays adult-only.", 409);
      }
      next.classification = patch.classification;
      next.classification_note = null;
    }
    records[index] = next;
    writeManifest(records);
    return next;
  });
}

export function removeLora(id: string): Promise<boolean> {
  return exclusive(() => {
    const records = readManifest();
    if (!records.some((record) => record.id === id)) return false;
    writeManifest(records.filter((record) => record.id !== id));
    rmSync(loraFile(id), { force: true });
    return true;
  });
}

/** What a person calls the model a base belongs to (Home owns the wording of its own screens; this is the Stack's plain error text). */
function baseLabel(base: LoraBase | undefined): string { return base === LORA_BASE_LTX ? "Detailed (LTX 2.3)" : base === LORA_BASE_LTX25 ? "LTX 2.5" : "Quick"; }

export interface LoraRequest { id: string; strength?: number; }
export interface ResolvedLora { record: LoraRecord; path: string; strength: number; /** LTX-2.5 only: what the runtime can map in this file (read again at request time). */ keys?: LtxLoraKeys; }

/** Turns a job's LoRA list into files to apply, or throws a LoraError that
 * says what to change. `audience` is the second lock: an all-ages job never
 * applies an adult-only file, whatever Home's list says. The file is
 * re-hashed when its size or time changed since it was added. */
export async function resolveLoras(requests: LoraRequest[] | undefined, audience: Audience, base: LoraBase = LORA_BASE_MODEL): Promise<ResolvedLora[]> {
  const list = requests ?? [];
  if (list.length > MAX_LORAS_PER_JOB) throw new LoraError("too_many_loras", `A clip can use at most ${MAX_LORAS_PER_JOB} LoRAs.`, 422);
  if (new Set(list.map((entry) => entry.id)).size !== list.length) throw new LoraError("duplicate_lora", "The same LoRA is listed twice.", 422);
  const out: ResolvedLora[] = [];
  for (const entry of list) {
    if (!isLoraId(entry.id)) throw new LoraError("unknown_lora", `No LoRA with the id ${String(entry.id).slice(0, 40)} is in the library.`, 422);
    const record = getLora(entry.id);
    if (!record) throw new LoraError("unknown_lora", `No LoRA with the id ${entry.id} is in the library.`, 422);
    if ((record.base_model ?? LORA_BASE_MODEL) !== base) throw new LoraError("wrong_base_model", `"${record.name}" was made for the ${baseLabel(record.base_model)} video model and this clip is ${baseLabel(base)}. Pick a style made for the same one.`, 422);
    const strength = entry.strength ?? record.strength_default;
    if (!(strength >= 0 && strength <= MAX_LORA_STRENGTH)) throw new LoraError("bad_strength", `A LoRA's strength must be between 0 and ${MAX_LORA_STRENGTH}.`, 422);
    if (record.classification === "adult-only" && audience !== "adult") throw new LoraError("lora_not_allowed", "That LoRA is adult-only and this clip is not for an adult audience.", 422);
    const path = loraFile(record.id);
    if (!existsSync(path)) throw new LoraError("lora_missing", `The file for "${record.name}" is missing from the library. Add it again.`, 422);
    const stat = statSync(path);
    if (stat.size !== record.bytes || Math.floor(stat.mtimeMs) !== record.mtime_ms) {
      if ((await sha256OfFile(path)) !== record.sha256) throw new LoraError("lora_changed", `The file for "${record.name}" changed after it was added, so it was not used. Remove it and add it again.`, 422);
    }
    // LTX-2.5: a file the runtime cannot map would run as a silent no-op, so it is refused here, before a job exists.
    let keys: LtxLoraKeys | undefined;
    if (base === LORA_BASE_LTX25) { keys = inspectLtxLoraKeys(path); assertLtxLoraKeys(keys, `"${record.name}"`); }
    out.push({ record, path, strength, ...(keys ? { keys } : {}) });
  }
  return out;
}

export function sha256OfBytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
