// The job runners behind POST /v1/images/generations and the generative
// operations of POST /v1/images/edits (IMGGEN-STACK-02, IMGGEN-EDIT-01). The
// job record (which Home lists and the event feed carries) holds only the size,
// the seed, the step count and the LoRA ids; the prompt and the pictures wait
// in memory under a token the route made, are taken by the runner once, and are
// never written to a record, a log or the results folder. The generator queue
// (lib/jobs.ts) gives the job its place in line and the governor's admission
// before a runner is called; one generator job runs at a time across pictures
// and video. The kinds are not role ids on purpose: a request for another role
// must never reach this runner.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerJobRunner, type Job } from "@/lib/jobs";
import { recordGeneratedImage } from "@/video/provenance";
import { commitResult, workDir, type ImageResultMeta } from "@/images/results";
import { ImageError, imageGen, overallPercent } from "@/images/imageEngine";
import { IMAGE_FAMILIES, isFamilyId, peakBytes } from "@/images/models";
import { LikenessError, recheck, type LikenessCheck } from "@/lib/likeness";

export const IMAGE_JOB_KIND = "image_generation";
export const IMAGE_EDIT_JOB_KIND = "image_edit_generative";

export interface StashedImage {
  op: "generate" | "edit";
  prompt: string;
  negativePrompt: string | null;
  family: string;
  quantize: number | null;
  width: number; height: number; steps: number; seed: number; count: number;
  loras: Array<[string, number]>;
  loraIds: string[];
  initImage: Uint8Array | null;
  strength: number;
  image: Uint8Array | null;
  mask: Uint8Array | null;
  region: [number, number, number, number] | null;
  feather: number;
  /** LIKENESS-01: the proofs this job rests on, checked again when it starts. */
  likeness?: LikenessCheck[];
  /** The starting picture was a photo someone brought, not one this Stack made: the output is not recorded as a free starting picture. */
  derived?: boolean;
}
const pending = new Map<string, StashedImage & { at: number }>();
const STASH_TTL_MS = 30 * 60_000;
/** A job cancelled or refused before its runner started never takes its stash, so anything older than half an hour goes. */
export function stashImage(token: string, item: StashedImage): void {
  const now = Date.now();
  for (const [key, value] of pending) if (now - value.at > STASH_TTL_MS) pending.delete(key);
  pending.set(token, { ...item, at: now });
}
export function unstashImage(token: string): StashedImage | null {
  const item = pending.get(token) ?? null;
  pending.delete(token);
  if (!item) return null;
  const { at: _at, ...rest } = item;
  return rest;
}

/** What a job is doing right now, for the status route (the job record carries the percent only). */
const progress = new Map<string, { phase: string; phasePercent: number }>();
const failures = new Map<string, { code: string; message: string; status: number }>();
export function imageProgress(job: string): { phase: string; phasePercent: number } | null { return progress.get(job) ?? null; }
export function imageFailure(job: string): { code: string; message: string; status: number } | null { return failures.get(job) ?? null; }
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  while (map.size > 200) map.delete(map.keys().next().value as string);
}

/** Width and height from a PNG's header, or null. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface ImageJobResult { job: string; model: string; mode: string; ms: number; images: Array<{ index: number; seed: number; width: number; height: number }>; }

function memoryFor(job: Job) {
  const input = (job.input ?? {}) as { family?: string; mode?: string; quantize?: number | null; lora_ids?: string[]; count?: number };
  const family = isFamilyId(input.family ?? "") ? input.family as keyof typeof IMAGE_FAMILIES : "flux2-klein-4b";
  const peak = peakBytes(family, input.mode === "edit" ? "edit" : "generate", input.quantize ?? null, input.lora_ids?.length ?? 0);
  return { requestedBytes: peak, measuredPeakBytes: peak, engine: "image-gen" };
}

export function registerImageJobs(): void {
  const runner = async (job: Job, signal: AbortSignal, update: (patch: { status?: string; percent?: number }) => void): Promise<ImageJobResult> => {
    const token = String((job.input as { token?: string } | null)?.token ?? "");
    const item = unstashImage(token);
    if (!item) throw new ImageError("failed", "The request was not received. Send it again.", 400);
    // A job can wait in the line for minutes: the proofs are checked again the moment it starts.
    try { recheck(item.likeness); } catch (error) {
      const refused = error instanceof LikenessError ? new ImageError(error.code, error.message, error.status) : new ImageError("likeness_proof_invalid", "The consent proof was not accepted. Ask Home to make it again.", 403);
      remember(failures, job.id, { code: refused.code, message: refused.message, status: refused.status });
      throw refused;
    }
    const work = workDir(job.id);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true, mode: 0o700 });
    try {
      const write = (name: string, bytes: Uint8Array | null): string | undefined => {
        if (!bytes) return undefined;
        const path = join(work, "..", `${job.id}.${name}`);
        writeFileSync(path, bytes, { mode: 0o600 });
        return path;
      };
      const staged: string[] = [];
      const keep = (path: string | undefined): string | undefined => { if (path) staged.push(path); return path; };
      const initImage = keep(write("init.bin", item.initImage));
      const image = keep(write("image.bin", item.image));
      const mask = keep(write("mask.bin", item.mask));
      const family = item.family as keyof typeof IMAGE_FAMILIES;
      try {
        const result = await imageGen.run({
          op: item.op, family, quantize: item.quantize, prompt: item.prompt, steps: item.steps, seed: item.seed, loras: item.loras, outDir: work,
          ...(item.op === "generate" ? { width: item.width, height: item.height, count: item.count } : {}),
          ...(initImage ? { initImage, strength: item.strength } : {}), ...(image ? { image } : {}), ...(mask ? { mask } : {}), ...(item.region ? { region: item.region } : {}), ...(item.op === "edit" ? { feather: item.feather } : {}),
        }, {
          jobId: job.id, signal,
          onPhase: (phase, phasePercent) => { remember(progress, job.id, { phase, phasePercent }); update({ status: phase, percent: overallPercent(phase, phasePercent) }); },
        });
        const count = item.op === "edit" ? 1 : item.count;
        const images = [] as ImageResultMeta["images"];
        for (let index = 0; index < count; index += 1) {
          const bytes = new Uint8Array(readFileSync(join(work, `${index}.png`)));
          const size = pngSize(bytes) ?? { width: result.width ?? item.width, height: result.height ?? item.height };
          images.push({ index, seed: result.seeds[index] ?? item.seed + index, width: size.width, height: size.height, bytes: bytes.length, thumb_bytes: Bun.file(join(work, `${index}.thumb.jpg`)).size });
          // A picture the Stack made may later start a clip; a photo someone brought may not (VIDEO-GEN-12).
          // A picture that looks like a person is not a free starting picture: using it again needs a fresh proof.
          if (!item.derived && (!item.likeness || item.likeness.length === 0)) recordGeneratedImage(bytes);
        }
        const meta: ImageResultMeta = {
          job: job.id, created: Math.floor(new Date(job.createdAt).getTime() / 1000), mode: item.op === "edit" ? (item.mask || item.region ? "edit-masked" : "edit") : item.initImage ? "image-to-image" : "generate",
          model: IMAGE_FAMILIES[family].catalogId, steps: item.steps, quantize: item.quantize, lora_ids: item.loraIds, ms: result.ms, mlx_peak_gb: result.peakBytes === null ? null : Math.round(result.peakBytes / 1e8) / 10, images,
        };
        update({ status: "ready", percent: 100 });
        commitResult(meta, work);
        remember(progress, job.id, { phase: "ready", phasePercent: 100 });
        return { job: job.id, model: meta.model, mode: meta.mode, ms: meta.ms, images: images.map(({ index, seed, width, height }) => ({ index, seed, width, height })) };
      } finally { for (const path of staged) rmSync(path, { force: true }); }
    } catch (error) {
      if (!signal.aborted && error instanceof ImageError) remember(failures, job.id, { code: error.code, message: error.message, status: error.status });
      else if (!signal.aborted) remember(failures, job.id, { code: "failed", message: error instanceof Error ? error.message : String(error), status: 500 });
      throw error;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };
  const options = { generator: { role: "image", memory: memoryFor } };
  registerJobRunner(IMAGE_JOB_KIND, runner, options);
  registerJobRunner(IMAGE_EDIT_JOB_KIND, runner, options);
}
