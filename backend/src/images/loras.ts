// IMGGEN-LORA-01: the household LoRA library for pictures, Stack side. One
// directory under data/images/loras (see lib/media/loraLibrary.ts for what a
// record holds and what the Stack does and does not decide). A LoRA belongs to
// one base model, read from its tensors: the Stack never asks the person which.
// Add by file, by path, or by Hugging Face URL through an install job that
// downloads, hashes and records the file.
import { createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { createJob, finishJob, jobSignal, updateJob, type Job } from "@/lib/jobs";
import { createLoraLibrary, LoraError, MAX_LORA_BYTES, type SafetensorsInfo, type LoraRecord } from "@/lib/media/loraLibrary";

export const IMAGE_LORA_BASES = ["flux2-klein-4b", "z-image-turbo"] as const;
export type ImageLoraBase = typeof IMAGE_LORA_BASES[number];
export const MAX_LORAS_PER_IMAGE = 4;

/** What a trainer wrote about the base model in the file's own header (kohya `ss_base_model_version`, `modelspec.architecture`, ai-toolkit `base_model`), lower case. Civitai files carry these. Empty when the file says nothing. */
function declaredBase(info: SafetensorsInfo): string {
  const meta = info.metadata ?? {};
  return ["ss_base_model_version", "modelspec.architecture", "base_model", "ss_sd_model_name", "ss_network_module"].map((key) => meta[key]).filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
}

/** Which base the tensors fit, from the key names and the hidden width: Klein 4B is 3072 wide with double and single blocks (or the diffusers names), Z-Image is 3840 wide with `layers.N` (or `layers_N` in the kohya naming a Civitai file may use, which must be checked before the SDXL `lora_unet_` prefix). SDXL-family files (SDXL, Pony, Illustrious, NoobAI), FLUX.1 files and Wan files are named in the refusal so a person knows where they go. A header that declares its base wins over a guess from the tensors. */
export function detectImageBase(info: SafetensorsInfo): ImageLoraBase {
  const keys = info.keys.join("\n");
  const declared = declaredBase(info);
  const wide = (width: number): boolean => info.dims.includes(width);
  const zimage = /(^|[._])layers[._]\d+[._](attention|adaLN_modulation|feed_forward)/.test(keys) && wide(3840);
  const sdxl = /sdxl|stable-diffusion-xl|pony|illustrious|noobai/.test(declared) || (!zimage && (/lora_unet_|input_blocks|down_blocks|output_blocks|conditioner|lora_te1?_/.test(keys) || (wide(640) && wide(1280))));
  const wan = /(^|\.)blocks\.\d+\.(self_attn|cross_attn)/.test(keys);
  if (wan) throw new LoraError("wrong_base_model", "This LoRA was made for a video model (Wan). Add it to the video library instead.", 422);
  if (sdxl) throw new LoraError("wrong_base_model", "This LoRA was made for Stable Diffusion XL (or Pony, Illustrious or NoobAI, which are built on it). This computer's picture models are FLUX.2 Klein 4B and Z-Image-Turbo; use a LoRA made for one of them.", 422);
  if (/flux[.\-_ ]?1|flux_dev|flux-dev|schnell|chroma/.test(declared)) throw new LoraError("wrong_base_model", "This LoRA was made for FLUX.1 (or Chroma, which is built on it). It does not fit FLUX.2 Klein 4B or Z-Image-Turbo; use a LoRA made for one of them.", 422);
  if (zimage || /z-image|zimage/.test(declared)) return "z-image-turbo";
  const klein = /double_blocks|single_blocks|double_stream_modulation|single_stream_modulation/.test(keys) && wide(3072) && !wide(3840);
  if (klein) return "flux2-klein-4b";
  throw new LoraError("wrong_base_model", "This LoRA was not made for FLUX.2 Klein 4B or Z-Image-Turbo, the picture models on this computer. Pick a LoRA made for one of those.", 422);
}

export const imageLoras = createLoraLibrary({ dir: () => join(dataDir, "images", "loras"), noun: "picture", maxPerJob: MAX_LORAS_PER_IMAGE, detectBase: detectImageBase });

// ---- by Hugging Face URL ----

export interface HfLoraSource { repo: string; revision: string; file: string; }

/** `https://huggingface.co/<owner>/<repo>/(resolve|blob)/<revision>/<path>.safetensors`; any other host or shape is refused (the Stack fetches from one named place and never follows a link someone else chose). */
export function parseHfLoraUrl(value: string): HfLoraSource {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new LoraError("bad_url", "That is not a link. Paste the file's address from huggingface.co.", 422); }
  if (url.protocol !== "https:" || url.hostname !== "huggingface.co" || url.username || url.password || url.port) throw new LoraError("bad_url", "Only links from huggingface.co can be fetched. Download the file yourself and add it as a file instead.", 422);
  const match = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:resolve|blob)\/([A-Za-z0-9._-]+)\/(.+\.safetensors)$/.exec(url.pathname);
  if (!match) throw new LoraError("bad_url", "The link must point at one .safetensors file, like https://huggingface.co/owner/name/resolve/main/file.safetensors.", 422);
  const file = decodeURIComponent(match[4]!);
  if (file.split("/").some((part) => part === ".." || part === "")) throw new LoraError("bad_url", "That file path is not valid.", 422);
  return { repo: `${match[1]}/${match[2]}`, revision: match[3]!, file };
}

export interface HfCard { licence: string | null; tags: string[]; }
/** The repository's licence and tags from the Hub API (public metadata; one request). */
export async function fetchHfCard(repo: string, fetchImpl: typeof fetch = fetch): Promise<HfCard> {
  try {
    const response = await fetchImpl(`https://huggingface.co/api/models/${repo}`, { headers: { accept: "application/json" } });
    if (!response.ok) return { licence: null, tags: [] };
    const body = await response.json() as { cardData?: { license?: string | string[] }; tags?: string[]; gated?: boolean | string };
    const licence = Array.isArray(body.cardData?.license) ? body.cardData!.license![0] : body.cardData?.license;
    return { licence: typeof licence === "string" ? licence : null, tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 200) : [] };
  } catch { return { licence: null, tags: [] }; }
}

export interface LoraUrlInput {
  url: string;
  name: string;
  licence?: string;
  licenceAcknowledged?: boolean;
  classification?: "all-ages" | "adult-only";
  strengthDefault?: number;
  triggerWords?: string[];
  addedBy?: string | null;
}

/** Streams the file to a temporary path with a size cap and no knowledge of its hash (the hash is computed on the bytes that arrived and recorded; nothing is trusted from the server). */
async function fetchTo(url: string, target: string, signal: AbortSignal | undefined, onBytes: (done: number, total: number) => void, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new LoraError("download_failed", `Hugging Face answered ${response.status} for that file. Check the link, and that the repository is public.`, 502);
  const total = Number(response.headers.get("content-length") ?? 0);
  if (total > MAX_LORA_BYTES) throw new LoraError("too_large", `That file is larger than ${MAX_LORA_BYTES / 1_073_741_824} GB, the most a LoRA can be here.`, 413);
  mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
  const out = createWriteStream(target, { mode: 0o600 });
  const reader = response.body.getReader();
  let done = 0;
  try {
    while (true) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      done += value.length;
      if (done > MAX_LORA_BYTES) throw new LoraError("too_large", `That file is larger than ${MAX_LORA_BYTES / 1_073_741_824} GB, the most a LoRA can be here.`, 413);
      if (!out.write(value)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      onBytes(done, total);
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
}

/** Starts an install job that fetches a LoRA from Hugging Face, hashes it and adds it to the library. The job's result is the record. */
export function startLoraInstall(input: LoraUrlInput, deps: { fetch?: typeof fetch } = {}): Job {
  const fetchImpl = deps.fetch ?? fetch;
  const source = parseHfLoraUrl(input.url);
  const job = createJob({ kind: "image.lora.install", role: "image", status: "downloading", input: { repo: source.repo, file: source.file } });
  const staging = join(dataDir, "tmp", "image-lora", `${job.id}.safetensors`);
  void (async () => {
    try {
      const card = await fetchHfCard(source.repo, fetchImpl);
      const licence = input.licence?.trim() || card.licence || "unknown";
      await fetchTo(`https://huggingface.co/${source.repo}/resolve/${source.revision}/${source.file.split("/").map(encodeURIComponent).join("/")}`, staging, jobSignal(job.id), (done, total) => updateJob(job.id, { completedBytes: done, totalBytes: total || done }), fetchImpl);
      updateJob(job.id, { status: "checking the file" });
      if (statSync(staging).size === 0) throw new LoraError("not_safetensors", "The download was empty.", 422);
      const record = await imageLoras.importFile({
        path: staging, name: input.name, licence, licenceAcknowledged: input.licenceAcknowledged, sourceUrl: `https://huggingface.co/${source.repo}/blob/${source.revision}/${source.file}`,
        classification: input.classification, strengthDefault: input.strengthDefault, triggerWords: input.triggerWords, addedBy: input.addedBy, extraDescription: [source.repo, ...card.tags],
      });
      finishJob(job.id, { ok: true, result: { lora: record satisfies LoraRecord } });
    } catch (error) {
      finishJob(job.id, { ok: false, reason: error instanceof LoraError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error) });
    } finally { rmSync(staging, { force: true }); }
  })();
  return job;
}
