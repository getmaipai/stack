// IMGGEN-LORA-01: the household LoRA library for pictures, Stack side. One
// directory under data/images/loras (see lib/media/loraLibrary.ts for what a
// record holds and what the Stack does and does not decide). A LoRA belongs to
// one base model, read from its tensors: the Stack never asks the person which.
// Add by file, by path, or by Hugging Face URL through an install job that
// downloads, hashes and records the file.
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { type Job } from "@/lib/jobs";
import { createLoraLibrary, LoraError, MAX_LORA_BYTES, type SafetensorsInfo, type LoraRecord } from "@/lib/media/loraLibrary";
import { LORA_INSTALL_SITES, parseInstallUrl, startInstall, sweepParts, type InstallSource } from "@/lib/media/loraInstallCore";

export const IMAGE_LORA_BASES = ["flux2-klein-4b", "z-image-turbo", "ernie-image-turbo"] as const;
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

const imagePartDirectory = () => join(dataDir, "tmp", "image-lora-install");
let imageInstalling: string | null = null;
export function __resetImageLoraInstallForTests(): void { imageInstalling = null; }
export type ImageLoraInstallInput = Omit<InstallSource, "site" | "licence"> & { licence?: string; site?: typeof LORA_INSTALL_SITES[number]; baseModel?: ImageLoraBase | null };
export function startLoraInstall(input: ImageLoraInstallInput, deps: { fetch?: typeof fetch } = {}): Job {
  const site = input.site ?? "huggingface";
  const prepared = { ...input, site };
  const fetchImpl = deps.fetch ?? fetch;
  return startInstall({ ...prepared, licence: input.licence ?? "unknown" }, { kind: "image.lora.install", role: "image", noun: "picture", duplicateCode: "already_added", partDir: imagePartDirectory, parseUrl: parseInstallUrl, get: imageLoras.get, importFile: async (options) => {
    let metadata: HfCard | null = null;
    if (site === "huggingface" && !input.licence?.trim()) { const source = parseHfLoraUrl(input.url); metadata = await fetchHfCard(source.repo, fetchImpl); }
    return imageLoras.importFile({ ...options, licence: input.licence?.trim() || metadata?.licence || "unknown", sourceUrl: input.sourceUrl ?? (site === "huggingface" ? input.url.replace("/resolve/", "/blob/") : input.url), extraDescription: metadata?.tags ?? [] } as Parameters<typeof imageLoras.importFile>[0]);
  }, readHeader: (path) => {
    try {
      imageLoras.readHeader(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && "status" in error) {
        throw new LoraError(String((error as { code: unknown }).code), error.message, Number((error as { status: unknown }).status));
      }
      throw error;
    }
  }, maxBytes: MAX_LORA_BYTES }, () => imageInstalling !== null, (id) => { imageInstalling = id; }, deps);
}

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
  url: string; name: string; licence?: string; licenceAcknowledged?: boolean; classification?: "all-ages" | "adult-only"; strengthDefault?: number; triggerWords?: string[]; addedBy?: string | null;
}
