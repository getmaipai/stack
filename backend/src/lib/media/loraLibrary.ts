// IMGGEN-LORA-01: the household LoRA library, one implementation for any
// generator that applies LoRAs to a base model (the picture generator now;
// the video library of VIDEO-GEN-03 keeps its own file and may move onto this
// one). A library is one directory of `.safetensors` files named by their
// content and one manifest. A record holds what Home needs to decide who may
// use a file and what the Stack needs to apply it: the sha256 and size, the
// source and licence, the base model read from the tensors (never from a
// name), a default strength, trigger words, who added it, and a
// classification, `all-ages` or `adult-only`.
//
// What the Stack decides and what it does not. It decides facts about the
// file: its hash, its rank, which base model it fits, whether its own
// metadata names adult content (then it cannot be all-ages) or names a minor
// in a sexual context (then it is refused outright, the absolute line no
// setting lifts) or a real, identifiable person's likeness (refused, the
// second absolute line). It does not decide who may use a file: Home does, per
// age band and surface, and a request names the LoRAs it is allowed to apply.
// As a second lock a request also states its audience; one whose audience is
// not `adult` can never apply an `adult-only` file, whatever list it sends.
//
// The word checks are a tripwire over file metadata, not a judgement of the
// pictures a LoRA makes. They live in one place so a rule change is one edit.
// A file with no metadata is `adult-only` unless the importer says otherwise
// (uncertain means adult-only).
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256OfFile } from "@/lib/fileHash";

export const LORA_CLASSES = ["all-ages", "adult-only"] as const;
export type LoraClass = typeof LORA_CLASSES[number];
export type Audience = "all-ages" | "adult";
export const MAX_LORA_STRENGTH = 2;
export const MAX_LORA_BYTES = 2 * 1_073_741_824;
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
  base_model: string;
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
const ADULT_WORDS = ["nsfw", "explicit", "nude", "nudity", "naked", "porn", "porno", "pornographic", "hentai", "sex", "sexual", "erotic", "lewd", "genitals", "xxx", "adult", "18+", "topless", "fetish", "bdsm", "cum", "boobs", "nipples", "pussy", "dick", "blowjob", "not-for-all-audiences"];
/** Words that mean the file is refused on their own. */
const MINOR_ALONE = ["loli", "lolicon", "shota", "shotacon"];
/** Words that mean the file is refused beside any adult word. */
const MINOR_WORDS = ["child", "children", "kid", "kids", "minor", "underage", "preteen", "toddler", "schoolgirl", "schoolboy", "teen", "teenage", "young girl", "young boy", "little girl", "little boy"];
/** Words that say the LoRA reproduces a real person's likeness (a CivitAI "person" or "celebrity" tag): refused for everyone. */
const REAL_PERSON_WORDS = ["celebrity", "celebrities", "real person", "real people", "likeness", "actress", "actor", "pornstar", "porn star", "influencer", "streamer", "politician", "supermodel"];
const wordRegex = (words: string[]) => new RegExp(`(^|[^a-z0-9])(${words.map((word) => word.replace(/[+]/g, "\\+")).join("|")})([^a-z0-9]|$)`, "i");
const ADULT_RE = wordRegex(ADULT_WORDS);
const MINOR_ALONE_RE = wordRegex(MINOR_ALONE);
const MINOR_RE = wordRegex(MINOR_WORDS);
const REAL_PERSON_RE = wordRegex(REAL_PERSON_WORDS);

/** Everything a person or a trainer wrote about the file, as one string to scan: metadata values, tag names, the name, the file name, the trigger words. */
export function describedAs(parts: Array<string | null | undefined>, metadata: Record<string, unknown> | undefined): string {
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

export function scanWords(text: string): { refuse: boolean; refuseReason: "minor" | "real_person" | null; adult: boolean } {
  const adult = ADULT_RE.test(text);
  if (MINOR_ALONE_RE.test(text) || (adult && MINOR_RE.test(text))) return { refuse: true, refuseReason: "minor", adult };
  if (REAL_PERSON_RE.test(text)) return { refuse: true, refuseReason: "real_person", adult };
  return { refuse: false, refuseReason: null, adult };
}

export interface SafetensorsInfo { rank: number; modules: number; dims: number[]; keys: string[]; metadata: Record<string, unknown> | undefined; }

/** Reads a safetensors header (the first 8 bytes say how long the JSON is) and what it says about LoRA tensors; throws a LoraError that says what to do. */
export function readLoraHeader(path: string): SafetensorsInfo {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const lengthBytes = Buffer.alloc(8);
    if (size < 16 || readSync(fd, lengthBytes, 0, 8, 0) !== 8) throw new LoraError("not_safetensors", "That file is not a LoRA: use a .safetensors file.", 422);
    const headerLength = Number(lengthBytes.readBigUInt64LE(0));
    if (!Number.isSafeInteger(headerLength) || headerLength <= 2 || headerLength > MAX_HEADER_BYTES || 8 + headerLength > size) throw new LoraError("not_safetensors", "That file is not a LoRA: use a .safetensors file.", 422);
    const raw = Buffer.alloc(headerLength);
    readSync(fd, raw, 0, headerLength, 8);
    let header: Record<string, { dtype?: string; shape?: number[]; data_offsets?: [number, number] } | Record<string, unknown>>;
    try { header = JSON.parse(raw.toString("utf8")); } catch { throw new LoraError("not_safetensors", "That file is not a LoRA: use a .safetensors file.", 422); }
    const metadata = header.__metadata__ as Record<string, unknown> | undefined;
    const dataLength = size - 8 - headerLength;
    const dims = new Set<number>();
    const keys: string[] = [];
    let rank = 0; let modules = 0;
    for (const [key, entry] of Object.entries(header)) {
      if (key === "__metadata__") continue;
      const tensor = entry as { shape?: number[]; data_offsets?: [number, number] };
      if (!tensor.shape || !tensor.data_offsets || tensor.data_offsets[1] > dataLength) throw new LoraError("not_safetensors", "That file looks cut short or damaged. Download it again.", 422);
      if (keys.length < 4000) keys.push(key);
      const down = /\.lora_(?:A|down)\.weight$/.test(key) || /\.lora_down\.weight$/.test(key);
      const up = /\.lora_(?:B|up)\.weight$/.test(key);
      if (down && tensor.shape.length === 2) { modules += 1; rank = Math.max(rank, tensor.shape[0]!); dims.add(tensor.shape[1]!); }
      if (up && tensor.shape.length === 2) dims.add(tensor.shape[0]!);
    }
    return { rank, modules, dims: [...dims], keys, metadata };
  } finally { closeSync(fd); }
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
  /** Extra words to scan beside the file's own (a Hugging Face card's tags). */
  extraDescription?: string[];
}

export interface LoraPatch { name?: string; classification?: LoraClass; strengthDefault?: number; triggerWords?: string[]; sourceUrl?: string | null; }
export interface LoraRequest { id?: string; sha256?: string; strength?: number; }
export interface ResolvedLora { record: LoraRecord; path: string; strength: number; }

export interface LoraLibraryConfig {
  /** The library's directory (a function: the data directory is read late). */
  dir: () => string;
  /** The word for the thing the LoRAs make, in error messages ("picture", "clip"). */
  noun: string;
  maxPerJob: number;
  /** Returns the base model the tensors fit, or throws a LoraError (422 wrong_base_model). */
  detectBase: (info: SafetensorsInfo) => string;
}

const ID_RE = /^lora-[0-9a-f]{16}$/;
export const isLoraId = (value: string): boolean => ID_RE.test(value);
const SHA_RE = /^[0-9a-f]{64}$/;

export function createLoraLibrary(config: LoraLibraryConfig) {
  const manifestPath = (): string => join(config.dir(), "manifest.json");
  const loraFile = (id: string): string => join(config.dir(), `${id}.safetensors`);

  function readManifest(): LoraRecord[] {
    try { const parsed = JSON.parse(readFileSync(manifestPath(), "utf8")) as { loras?: LoraRecord[] }; return Array.isArray(parsed.loras) ? parsed.loras : []; } catch { return []; }
  }
  function writeManifest(records: LoraRecord[]): void {
    mkdirSync(config.dir(), { recursive: true, mode: 0o700 });
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

  const cleanWords = (words: string[] | undefined): string[] => (words ?? []).map((word) => word.trim()).filter((word) => word.length > 0 && word.length <= 200).slice(0, 20);

  const list = (): LoraRecord[] => readManifest().map((record) => ({ ...record }));
  const get = (id: string): LoraRecord | null => readManifest().find((record) => record.id === id) ?? null;
  const bySha = (sha256: string): LoraRecord | null => readManifest().find((record) => record.sha256 === sha256) ?? null;

  async function importFile(input: ImportInput): Promise<LoraRecord> {
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
    if (info.modules === 0) throw new LoraError("not_a_lora", "That file has no LoRA weights in a form this generator reads (it needs lora_A and lora_B, or lora_down and lora_up, tensors).", 422);
    const baseModel = config.detectBase(info);
    const triggerWords = cleanWords(input.triggerWords);
    const text = describedAs([name, ...triggerWords, input.path.split("/").pop(), input.sourceUrl, ...(input.extraDescription ?? [])], info.metadata);
    const words = scanWords(text);
    if (words.refuse && words.refuseReason === "minor") throw new LoraError("lora_refused", "This LoRA's own description names a child or a minor in a sexual context. It cannot be added; no setting allows that.", 422);
    if (words.refuse) throw new LoraError("lora_refused", "This LoRA's own description says it reproduces a real person's likeness. It cannot be added: no setting allows pictures of a real, identifiable person that they have not agreed to.", 422);
    const sha256 = await sha256OfFile(input.path);
    const id = `lora-${sha256.slice(0, 16)}`;
    return exclusive(() => {
      const records = readManifest();
      if (records.some((record) => record.id === id)) throw new LoraError("already_added", "This LoRA is already in the library.", 409);
      mkdirSync(config.dir(), { recursive: true, mode: 0o700 });
      const target = loraFile(id);
      const temp = `${target}.${process.pid}.part`;
      copyFileSync(input.path, temp);
      renameSync(temp, target);
      const asked: LoraClass = input.classification ?? "adult-only";
      const classification: LoraClass = words.adult ? "adult-only" : asked;
      const record: LoraRecord = {
        id, name, file: `${id}.safetensors`, sha256, bytes: stat.size, mtime_ms: Math.floor(statSync(target).mtimeMs), rank: info.rank, modules: info.modules, base_model: baseModel,
        licence, licence_class: klass, source_url: input.sourceUrl?.slice(0, 2000) ?? null, classification,
        classification_note: words.adult && asked === "all-ages" ? "The file's own description names adult content, so it is adult-only." : null,
        strength_default: input.strengthDefault ?? 1, trigger_words: triggerWords, added_by: input.addedBy?.slice(0, 200) ?? null, added_at: new Date().toISOString(),
      };
      writeManifest([...records, record]);
      return record;
    });
  }

  /** Edits a record. The Stack keeps the one fact it can check: a file whose metadata names adult content cannot be set all-ages. Who may change the class is Home's rule. */
  function update(id: string, patch: LoraPatch): Promise<LoraRecord> {
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

  function remove(id: string): Promise<boolean> {
    return exclusive(() => {
      const records = readManifest();
      if (!records.some((record) => record.id === id)) return false;
      writeManifest(records.filter((record) => record.id !== id));
      rmSync(loraFile(id), { force: true });
      return true;
    });
  }

  /** Turns a request's LoRA list into files to apply, or throws a LoraError that says what to change. `audience` is the second lock; `baseModel` is the model the job runs (a LoRA for another base is refused). The file is re-hashed when its size or time changed since it was added. */
  async function resolve(requests: LoraRequest[] | undefined, audience: Audience, baseModel: string): Promise<ResolvedLora[]> {
    const wanted = requests ?? [];
    if (wanted.length > config.maxPerJob) throw new LoraError("too_many_loras", `A ${config.noun} can use at most ${config.maxPerJob} LoRAs.`, 422);
    const out: ResolvedLora[] = [];
    const seen = new Set<string>();
    for (const entry of wanted) {
      const record = entry.id !== undefined ? (isLoraId(entry.id) ? get(entry.id) : null) : entry.sha256 !== undefined && SHA_RE.test(entry.sha256) ? bySha(entry.sha256) : null;
      if (!record) throw new LoraError("unknown_lora", `No LoRA with the id ${String(entry.id ?? entry.sha256 ?? "").slice(0, 40)} is in the library.`, 422);
      if (seen.has(record.id)) throw new LoraError("duplicate_lora", "The same LoRA is listed twice.", 422);
      seen.add(record.id);
      const strength = entry.strength ?? record.strength_default;
      if (!(strength >= 0 && strength <= MAX_LORA_STRENGTH)) throw new LoraError("bad_strength", `A LoRA's strength must be between 0 and ${MAX_LORA_STRENGTH}.`, 422);
      if (record.base_model !== baseModel) throw new LoraError("wrong_base_model", `"${record.name}" was made for ${record.base_model}, and this ${config.noun} uses ${baseModel}. Pick a LoRA made for ${baseModel}.`, 422);
      if (record.classification === "adult-only" && audience !== "adult") throw new LoraError("lora_not_allowed", `That LoRA is adult-only and this ${config.noun} is not for an adult audience.`, 422);
      const path = loraFile(record.id);
      if (!existsSync(path)) throw new LoraError("lora_missing", `The file for "${record.name}" is missing from the library. Add it again.`, 422);
      const stat = statSync(path);
      if (stat.size !== record.bytes || Math.floor(stat.mtimeMs) !== record.mtime_ms) {
        if ((await sha256OfFile(path)) !== record.sha256) throw new LoraError("lora_changed", `The file for "${record.name}" changed after it was added, so it was not used. Remove it and add it again.`, 422);
      }
      out.push({ record, path, strength });
    }
    return out;
  }

  return { list, get, bySha, importFile, update, remove, resolve, path: loraFile, dir: config.dir };
}

export function sha256OfBytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
