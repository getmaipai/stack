// COMPOSITE-SWAP-01: the composite step of a head swap. A guided swap model redraws the whole frame, so its clip is only a donor; this worker keeps every
// original pixel outside a head mask and puts colour-matched donor pixels inside it (docs: Home repo, docs/design/swap-composite-lessons-2026-11-17.md).
// Model independent: a model pack's swap adapter calls compositeSwap() and supplies its own donor clips. No network.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import { engineTagRoot } from "@/lib/store/layout";
import requirements from "./composite-swap.darwin-arm64.requirements.txt" with { type: "file" };
import worker from "./composite_swap_worker.py" with { type: "file" };

export const COMPOSITE_SWAP_NAME = "composite-swap";
export const COMPOSITE_SWAP_VERSION = "1.0.0";
export function compositeSwapRequirementsFileFor(platform = process.platform, arch = process.arch): string | null { return platform === "darwin" && arch === "arm64" ? requirements : null; }
export function compositeSwapRoot(): string { return engineTagRoot(COMPOSITE_SWAP_NAME, COMPOSITE_SWAP_VERSION); }
export function compositeSwapProof(): string { return join(compositeSwapRoot(), "venv", "lib", "python3.12", "site-packages", "cv2", "__init__.py"); }
function spec(): UvEnvironmentSpec { return { name: COMPOSITE_SWAP_NAME, version: COMPOSITE_SWAP_VERSION, root: compositeSwapRoot(), requirements: compositeSwapRequirementsFileFor(), proof: compositeSwapProof() }; }
export function compositeSwapEnvironmentReady(): boolean { return uvEnvironmentReady(spec()); }
export async function ensureCompositeSwapEnvironment(onProgress: (phase: string) => void = () => {}, signal?: AbortSignal): Promise<void> {
  if (!compositeSwapRequirementsFileFor()) throw new Error(`The swap composite step is not available on ${process.platform} ${process.arch} yet.`);
  await ensureUvEnvironment(spec(), onProgress, { signal });
}
export function compositeSwapPython(): string { return process.env.COMPOSITE_SWAP_PYTHON || join(uvVenvPath(compositeSwapRoot()), "bin", "python"); }
/** The worker as a real file: in the compiled Stack the embedded asset is a virtual path Python cannot open, so it is written under the environment folder first. */
export async function materializeCompositeSwapWorker(): Promise<string> {
  const root = compositeSwapRoot(); mkdirSync(root, { recursive: true });
  const target = join(root, "composite_swap_worker.py"); writeFileSync(target, await Bun.file(worker).text()); return target;
}
export { worker as compositeSwapWorkerScript };

export interface CompositeSwapInput {
  source: string; donor: string; out: string; reportPath?: string;
  /** Seconds into the source clip where the donor's segment starts, and its length. */
  start?: number; seconds?: number;
  /** x,y,w,h of burned-in text to erase from the guide and the source before compositing. */
  captionBox?: [number, number, number, number];
  /** 0.4 for slow shots, 0.7 for fast head motion. */
  flowAlpha?: number; maskSmoothFrames?: number;
  /** The source's own frame rate (24 when absent); the donor is resampled to it and the composite is written at it. */
  fps?: number;
  editRegionFile?: string;
  ffmpeg?: string; ffprobe?: string; signal?: AbortSignal;
}
export interface CompositeSwapReport {
  frames: number; size: [number, number];
  mouth_flicker_original: number; mouth_flicker_raw: number; mouth_flicker_filtered: number; flicker_ratio: number | null; flicker_ok: boolean;
  /** [frame, share of the original's skin pixels left unchanged] for frames above the flag share (an upper bound on dark footage). */
  residual_original_head_frames: Array<[number, number]>;
  edit_region: { source: "detected" | "supplied"; head_scale: number; margin_frac: number; frames_with_region: number };
  mask_clipped_pixels: number;
  preservation: { verdict: "pass" | "fail" | "inconclusive"; baseline?: { source: "global_color_transform" | "none"; matrix?: number[][]; offset?: number[]; within_bounds?: boolean; standard?: string | null; chroma?: string }; pre_encode?: "run" | "not_run"; changed_pixels: number | null; violating_frames: number[]; encoded: { persistent_pixels: number; largest_blob_px: number; share_gt8: number; max_diff: number; drift_masked_px?: number; strong_blob_px?: number } | null; map_path: string | null; reasons: string[] };
  /** The caption box that was erased (clamped inside the frame), and the share of its text edges that survived the erase (0 clean, 1 untouched; null when there was no text). */
  caption_box?: [number, number, number, number] | null; caption_residue?: number | null;
}
export type CompositeSwapResult = { ok: true; report: CompositeSwapReport } | { ok: false; line: string; code?: string };
export type CompositeSwapRunner = (command: string[], env: Record<string, string>, signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string }>;

const ENVIRONMENT_MISSING = "The swap composite step is not installed yet. Install it from the AI and models page, then try the swap again.";
const GENERIC_FAILURE = "The swap composite step could not finish. Try the swap again with a shorter clip.";
let runner: CompositeSwapRunner = async (command, env, signal) => {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", env });
  const abort = () => child.kill(); signal?.addEventListener("abort", abort, { once: true });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  signal?.removeEventListener("abort", abort); return { code, stdout, stderr };
};
export function __setCompositeSwapRunnerForTests(next: CompositeSwapRunner | null): void { runner = next ?? runner; }

/** The worker's environment: the Stack's own ffmpeg and ffprobe go in under the names the whole Stack uses (STACK_MEDIA_FFMPEG, STACK_MEDIA_FFPROBE), so the worker never depends on what a service manager's PATH holds. A path the caller resolved wins over one already in the environment. */
export function compositeSwapEnv(tools: { ffmpeg?: string; ffprobe?: string } = {}): Record<string, string> {
  const ffmpeg = tools.ffmpeg ?? process.env.STACK_MEDIA_FFMPEG ?? "ffmpeg";
  const ffprobe = tools.ffprobe ?? process.env.STACK_MEDIA_FFPROBE ?? "ffprobe";
  return managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", STACK_MEDIA_FFMPEG: ffmpeg, STACK_MEDIA_FFPROBE: ffprobe, COMPOSITE_SWAP_FFMPEG: ffmpeg, COMPOSITE_SWAP_FFPROBE: ffprobe });
}

export function compositeSwapArgs(input: CompositeSwapInput, workerPath: string): string[] {
  const args = [compositeSwapPython(), workerPath, "--source", input.source, "--donor", input.donor, "--out", input.out, "--start", String(input.start ?? 0), "--seconds", String(input.seconds ?? 2.3333)];
  if (input.captionBox) args.push("--caption-box", input.captionBox.join(","));
  if (input.editRegionFile) args.push("--edit-region-file", input.editRegionFile);
  if (input.reportPath) args.push("--report", input.reportPath);
  if (input.flowAlpha !== undefined) args.push("--flow-alpha", String(input.flowAlpha));
  if (input.maskSmoothFrames !== undefined) args.push("--mask-smooth-frames", String(input.maskSmoothFrames));
  if (input.fps !== undefined) args.push("--fps", String(input.fps));
  return args;
}

function environmentMissing(): boolean { return process.env.COMPOSITE_SWAP_PYTHON ? !existsSync(process.env.COMPOSITE_SWAP_PYTHON) : !compositeSwapEnvironmentReady(); }

/** Runs the worker once and returns its last stdout line as JSON, or one plain line. A missing environment, a cancelled run and any failure each come back as one line (what went wrong, what to do). */
async function runWorker<T extends object>(args: string[], tools: { ffmpeg?: string; ffprobe?: string }, signal: AbortSignal | undefined, isResult: (value: Record<string, unknown>) => boolean): Promise<{ ok: true; value: T } | { ok: false; line: string; code?: string }> {
  if (environmentMissing()) return { ok: false, line: ENVIRONMENT_MISSING, code: "environment_missing" };
  let result;
  try { result = await runner(args, compositeSwapEnv(tools), signal); } catch { return { ok: false, line: GENERIC_FAILURE }; }
  if (signal?.aborted) return { ok: false, line: "The swap was cancelled before the composite step finished.", code: "cancelled" };
  const last = result.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  let parsed: Record<string, unknown> | null; try { parsed = JSON.parse(last) as Record<string, unknown>; } catch { parsed = null; }
  if (result.code !== 0) { const error = parsed?.error; return { ok: false, line: typeof error === "string" && error ? error : GENERIC_FAILURE, ...(typeof parsed?.code === "string" ? { code: parsed.code } : {}) }; }
  if (!parsed || !isResult(parsed)) return { ok: false, line: GENERIC_FAILURE };
  return { ok: true, value: parsed as T };
}

export async function compositeSwap(input: CompositeSwapInput): Promise<CompositeSwapResult> {
  if (environmentMissing()) return { ok: false, line: ENVIRONMENT_MISSING, code: "environment_missing" };
  const workerPath = await materializeCompositeSwapWorker();
  const done = await runWorker<CompositeSwapReport>(compositeSwapArgs(input, workerPath), input, input.signal, (v) => typeof v.frames === "number");
  return done.ok ? { ok: true, report: done.value } : done;
}

export interface ClipAnalysis {
  /** x,y,w,h of burned-in text at source size, or null when none was found. */
  caption_box: [number, number, number, number] | null; size: [number, number];
  /** The most faces seen in one sampled frame, and the share of sampled frames with more than one. */
  people_max: number; many_people_share: number;
  /** Per requested segment: whether the head reaches the left, top or right edge of the frame. */
  segments: Array<{ edge_contact: boolean }>;
}
/** Looks at the source before any model runs: caption, people, framing. `segments` are [start, seconds] pairs in the source's own time. */
export async function analyzeClip(input: { source: string; start: number; seconds: number; segments: Array<[number, number]>; ffmpeg?: string; ffprobe?: string; signal?: AbortSignal }): Promise<{ ok: true; analysis: ClipAnalysis } | { ok: false; line: string; code?: string }> {
  if (environmentMissing()) return { ok: false, line: ENVIRONMENT_MISSING, code: "environment_missing" };
  const workerPath = await materializeCompositeSwapWorker();
  const args = [compositeSwapPython(), workerPath, "--mode", "analyze", "--source", input.source, "--start", String(input.start), "--seconds", String(input.seconds), "--segments", input.segments.map(([a, b]) => `${a}:${b}`).join(",")];
  const done = await runWorker<ClipAnalysis>(args, input, input.signal, (v) => Array.isArray(v.segments) && typeof v.people_max === "number");
  return done.ok ? { ok: true, analysis: done.value } : done;
}

/** One square crop of one face per reference picture, written under `outDir`. The worker refuses a picture with no face, one with several people and more than nine pictures, each with a plain line and a code (`no_face`, `many_people`, `too_many_references`, `unreadable`). */
export async function referenceCrops(input: { references: string[]; outDir: string; ffmpeg?: string; ffprobe?: string; signal?: AbortSignal }): Promise<{ ok: true; crops: string[] } | { ok: false; line: string; code?: string }> {
  if (environmentMissing()) return { ok: false, line: ENVIRONMENT_MISSING, code: "environment_missing" };
  const workerPath = await materializeCompositeSwapWorker();
  const args = [compositeSwapPython(), workerPath, "--mode", "crops", "--references", input.references.join(","), "--out-dir", input.outDir];
  const done = await runWorker<{ crops: string[] }>(args, input, input.signal, (v) => Array.isArray(v.crops));
  return done.ok ? { ok: true, crops: done.value.crops } : done;
}
