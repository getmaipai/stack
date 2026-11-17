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
  ffmpeg?: string; ffprobe?: string; signal?: AbortSignal;
}
export interface CompositeSwapReport {
  frames: number; size: [number, number];
  mouth_flicker_original: number; mouth_flicker_raw: number; mouth_flicker_filtered: number; flicker_ratio: number | null; flicker_ok: boolean;
  /** [frame, share of the original's skin pixels left unchanged] for frames above the flag share (an upper bound on dark footage). */
  residual_original_head_frames: Array<[number, number]>;
  /** Pixels more than 12 px from the mask that differ from the original (must be 0), and original skin recoloured on purpose, counted apart. */
  outside_mask_pixels_changed: number; recoloured_leftover_skin_pixels: number;
}
export type CompositeSwapResult = { ok: true; report: CompositeSwapReport } | { ok: false; line: string };
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

export function compositeSwapArgs(input: CompositeSwapInput, workerPath: string): string[] {
  const args = [compositeSwapPython(), workerPath, "--source", input.source, "--donor", input.donor, "--out", input.out, "--start", String(input.start ?? 0), "--seconds", String(input.seconds ?? 2.3333)];
  if (input.captionBox) args.push("--caption-box", input.captionBox.join(","));
  if (input.reportPath) args.push("--report", input.reportPath);
  if (input.flowAlpha !== undefined) args.push("--flow-alpha", String(input.flowAlpha));
  if (input.maskSmoothFrames !== undefined) args.push("--mask-smooth-frames", String(input.maskSmoothFrames));
  return args;
}

/** Runs the composite worker. A missing environment, a cancelled run and any failure each come back as one plain line (what went wrong, what to do). */
export async function compositeSwap(input: CompositeSwapInput): Promise<CompositeSwapResult> {
  if (process.env.COMPOSITE_SWAP_PYTHON ? !existsSync(process.env.COMPOSITE_SWAP_PYTHON) : !compositeSwapEnvironmentReady()) return { ok: false, line: ENVIRONMENT_MISSING };
  const workerPath = await materializeCompositeSwapWorker();
  const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", COMPOSITE_SWAP_FFMPEG: input.ffmpeg ?? "ffmpeg", COMPOSITE_SWAP_FFPROBE: input.ffprobe ?? "ffprobe" });
  let result;
  try { result = await runner(compositeSwapArgs(input, workerPath), env, input.signal); } catch { return { ok: false, line: GENERIC_FAILURE }; }
  if (input.signal?.aborted) return { ok: false, line: "The swap was cancelled before the composite step finished." };
  const last = result.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  let parsed: unknown; try { parsed = JSON.parse(last); } catch { parsed = null; }
  if (result.code !== 0) { const error = (parsed as { error?: unknown } | null)?.error; return { ok: false, line: typeof error === "string" && error ? error : GENERIC_FAILURE }; }
  if (!parsed || typeof (parsed as { frames?: unknown }).frames !== "number") return { ok: false, line: GENERIC_FAILURE };
  return { ok: true, report: parsed as CompositeSwapReport };
}
