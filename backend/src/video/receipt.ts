// VF-RECEIPT-01: the receipt of one video job, written beside its result (data/video/results/<job>/receipt.json) and served on the
// owner's route only. The shape is the spec's `StackVideoReceipt` (@maipai/spec, stack-video-receipt). It is part of the owner's job
// record (rule 6a): the prompt is a byte count and a hash, never its text; each input is a role and a hash, never a file name; nothing in
// here is written to a log, a status answer, an event or an admin view. The facts of the two files (native and delivered) are probed from
// the files themselves, never taken from what the generator reported.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { StackVideoReceipt, type StackVideoReceipt as Receipt } from "@maipai/spec/stack/ts/stack-video-receipt.js";
import { defaultToolbox } from "@/media/tools";
import { probeFile } from "@/media/probe";
import { spawnRunner } from "@/media/run";

export type ReceiptFile = Receipt["native"];
export type ReceiptRole = Receipt["inputs"][number]["role"];
export type ReceiptOperation = Receipt["operation"];

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
/** The hash of a file the job read, streamed in one read (an edit's source clip is at most a few hundred megabytes). */
export function sha256File(path: string): { sha256: string; bytes: number } { const bytes = readFileSync(path); return { sha256: sha256Hex(bytes), bytes: bytes.length }; }

/** Probes one file; the seam lets a test answer without ffprobe. */
export type ReceiptProbe = (path: string, signal?: AbortSignal) => Promise<ReceiptFile | null>;
async function ffprobeFile(path: string, signal?: AbortSignal): Promise<ReceiptFile | null> {
  try {
    // Never installs a tool for a receipt: a computer without ffprobe has no finished clip to describe, and the generator's own report stands in.
    if (!defaultToolbox.installed("ffprobe")) return null;
    const ffprobe = await defaultToolbox.path("ffprobe", () => {}, signal);
    const probe = await probeFile(spawnRunner, ffprobe, path, signal);
    const video = probe.streams.find((stream) => stream.type === "video" && !stream.cover_art);
    if (!video || !video.width || !video.height) return null;
    const fps = video.fps ?? 24;
    const seconds = video.duration_s ?? probe.duration_s ?? 0;
    return { width: video.width, height: video.height, frames: Math.round(seconds * fps), fps, seconds: Math.round(seconds * 1000) / 1000, audio: probe.has_audio, bytes: probe.size_bytes };
  } catch { return null; }
}
let probeImpl: ReceiptProbe = ffprobeFile;
export function setReceiptProbeForTests(probe: ReceiptProbe | null): void { probeImpl = probe ?? ffprobeFile; }
export const probeReceiptFile: ReceiptProbe = (path, signal) => probeImpl(path, signal);

/** What the generator said it made, used only when a file cannot be probed (the tools are missing); the receipt then still holds the file's real byte count. */
export function reportedFile(path: string, reported: { width: number; height: number; frames: number; fps: number; audio: boolean }): ReceiptFile {
  let bytes = 0; try { bytes = statSync(path).size; } catch { /* the file is gone */ }
  return { width: reported.width, height: reported.height, frames: reported.frames, fps: reported.fps, seconds: Math.round((reported.frames / reported.fps) * 1000) / 1000, audio: reported.audio, bytes };
}

export interface ReceiptFacts {
  runtime: { id: string; revision: string };
  model: { id: string; build: string; quantization: string | null };
  steps: { count: number | null; schedule: string | null };
  adapter: Receipt["adapter"];
}

export interface BuildReceiptInput extends ReceiptFacts {
  job: string;
  operation: ReceiptOperation;
  madeAt: Date;
  requested: Receipt["requested"];
  native: ReceiptFile;
  delivered: ReceiptFile;
  deliveredIs: Receipt["delivered_is"];
  seed: number | null;
  /** Phase names with the time each took, in order. */
  phases: Array<{ name: string; ms: number }>;
  peakBytes: number | null;
  finish: Receipt["finish"];
  /** The prompt the model was given; only its length in bytes and its hash are kept. */
  prompt: string;
  /** VF-PROMPT-01: the prompt writer that made it, its version and the hints it recorded (advice and counts, never text). */
  promptWriter?: { id: string; version: string } | undefined;
  promptHints?: readonly string[] | undefined;
  inputs: Receipt["inputs"];
}

/** The receipt, validated against the spec's shape so a wrong one is never written. */
export function buildReceipt(input: BuildReceiptInput): Receipt {
  const prompt = new TextEncoder().encode(input.prompt);
  return StackVideoReceipt.parse({
    version: 1, job_id: input.job, operation: input.operation, made_at: input.madeAt.toISOString(),
    runtime: input.runtime, model: input.model, steps: input.steps, adapter: input.adapter, inputs: input.inputs,
    requested: input.requested, native: input.native, delivered: input.delivered, delivered_is: input.deliveredIs,
    seed: input.seed, phases: input.phases.map((phase) => ({ name: phase.name, ms: Math.max(0, Math.round(phase.ms)) })),
    peak_memory_bytes: input.peakBytes, finish: input.finish, prompt: { bytes: prompt.length, sha256: sha256Hex(prompt), ...(input.promptWriter ? { writer: input.promptWriter } : {}), ...(input.promptHints?.length ? { hints: [...input.promptHints] } : {}) },
  });
}

/** Phase times from the order the job entered them: each phase lasts until the next begins. */
export function phaseDurations(entered: Array<{ name: string; at: number }>, endedAt: number): Array<{ name: string; ms: number }> {
  const out: Array<{ name: string; ms: number }> = [];
  entered.forEach((entry, index) => {
    const next = entered[index + 1]?.at ?? endedAt;
    const last = out[out.length - 1];
    if (last && last.name === entry.name) last.ms += next - entry.at; else out.push({ name: entry.name, ms: next - entry.at });
  });
  return out;
}
