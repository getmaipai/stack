// LTX25-ENGINE-01 (VIDEO-TIERS-01 in Home): the LTX-2.5 video engine beside Quick (Wan) and Detailed (LTX-2.3). The runtime is the
// fork MrMoferFRAN/ltx-2-mlx (branch ltx25, commit 5795228, MIT) pinned in engineCatalog as `ltx25-gen`; its packages are the
// pinned source archive on PYTHONPATH and its Python packages are a hashed requirements file built into one managed Python 3.12
// environment by the same uv builder as every other engine. The weights are the ungated q8 distilled pack (modelCatalog,
// STACK_VIDEO_LTX25_MODEL), read from the Stack's own model folder with HF_HUB_OFFLINE=1: nothing is fetched at generation time.
//
// What the Stack allows is exactly what was measured (M5 Max, 128 GB, OS footprint by /usr/bin/time -l, generation only, 2026-11-02),
// never an extrapolation. A size and a length outside this table are refused with a plain sentence (the worker checks the same
// table), and 1024x576 is not listed because it measured 68.6 to 69.2 GB and so fails the owner's 64 GB per-clip cap.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { installedEnginePin, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { ensureEngine } from "@/lib/engineInstall";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import { LTX25_MAX_GEMMA_FOLDER, LTX25_MAX_REQUIRED_FILES, LTX25_REQUIRED_FILES, STACK_VIDEO_LTX25_MAX_MODEL_ID, STACK_VIDEO_LTX25_MODEL_ID } from "@/lib/modelCatalog";
import { getModel } from "@/lib/modelStore";
import darwinArm64Requirements from "./ltx25-gen.darwin-arm64.requirements.txt" with { type: "file" };
import maxDarwinArm64Requirements from "./ltx25-max-gen.darwin-arm64.requirements.txt" with { type: "file" };
import ltx25WorkerScript from "./ltx25_worker.py" with { type: "file" };

export const LTX25_GEN_NAME = "ltx25-gen";
export const LTX25_GEN_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === LTX25_GEN_NAME)?.version ?? "5795228";
/** What a request's `model` may say for this engine, plus the model record's own id. */
export const LTX25_MODEL_NAMES = ["ltx25-q8", "ltx25"] as const;
export const LTX25_FPS = 24;

const GB = 1_000_000_000;
/** One measured row: a size, the longest clip measured at it, and the OS footprint of that clip. Shorter clips at the same size are admitted at the same figure (a shorter clip never needs more). */
export interface Ltx25Row { size: string; width: number; height: number; maxSeconds: number; peakBytes: number; /** The slot Home's tier design gives it (Home owns the wording). */ profile: "standard" | "boost" }
export const LTX25_MEASURED: readonly Ltx25Row[] = [
  // 512x256 (asked for as 512x288): 5 s 27 to 52 s and 25.3 GB; 10 s 43 s and 39.4 GB (the Standard slot).
  { size: "512x256", width: 512, height: 256, maxSeconds: 10, peakBytes: 39.4 * GB, profile: "standard" },
  // 640x320 (asked for as 640x352): 5 s 42 to 49 s, 32.4 GB. 10 s was not measured, so it is not offered.
  { size: "640x320", width: 640, height: 320, maxSeconds: 5, peakBytes: 32.4 * GB, profile: "boost" },
  // 768x448: 5 s 64 to 74 s, 45.8 GB. 10 s was not measured, so it is not offered.
  { size: "768x448", width: 768, height: 448, maxSeconds: 5, peakBytes: 45.8 * GB, profile: "boost" },
];
/** The 5 s footprint of the Standard size, for a clip of 5 s or less at it (a 5 s clip at 512x256 measured 25.3 GB). */
export const LTX25_STANDARD_5S_PEAK_BYTES = 25.3 * GB;
/** The largest measured footprint: the figure the status and the static admission check use. */
export const LTX25_PEAK_BYTES = Math.max(...LTX25_MEASURED.map((row) => row.peakBytes));
export const LTX25_DEFAULT_SIZE = "512x256";
export const LTX25_MAX_SECONDS = Math.max(...LTX25_MEASURED.map((row) => row.maxSeconds));
export const LTX25_MAX_FRAMES = LTX25_MAX_SECONDS * LTX25_FPS + 1;

/**
 * The one nominal-to-true mapping. The distilled two-stage engine draws stage one at half size and needs that half to be a multiple
 * of 32, so it rounds each side DOWN to a multiple of 64 (a request for 512x288 comes out 512x256, 640x352 comes out 640x320,
 * 768x448 and 1024x576 are already exact; checked with ffprobe on the judged clips). Every size, limit and footprint here is the
 * true one; a request may name the nominal size.
 */
export function ltx25TrueSize(width: number, height: number): { width: number; height: number } {
  return { width: Math.floor(width / 64) * 64, height: Math.floor(height / 64) * 64 };
}
/** The row of a size (nominal or true), or null when its true size was not measured. */
export function ltx25Row(width: number, height: number): Ltx25Row | null {
  const true_ = ltx25TrueSize(width, height);
  return LTX25_MEASURED.find((row) => row.width === true_.width && row.height === true_.height) ?? null;
}
/** A plain refusal for a size and a frame count outside the measured table, or null when the clip is allowed. Frames must be 8n+1. */
export function ltx25Refusal(width: number, height: number, frames: number): string | null {
  const row = ltx25Row(width, height);
  if (!row) return `This video model makes ${LTX25_MEASURED.map((item) => item.size).join(", ")} (a height between is rounded down to a multiple of 64, so 512x288 gives 512x256). Pick one of those sizes.`;
  if (!Number.isInteger(frames) || frames < 9 || (frames - 1) % 8 !== 0) return "The length must be a whole number of frames that is one more than a multiple of 8 (for example 121 frames, 5 seconds at 24 a second).";
  if (frames > row.maxSeconds * LTX25_FPS + 1) return `At ${row.size} a clip is at most ${row.maxSeconds} seconds on this computer. A longer clip needs the ${LTX25_MEASURED.filter((item) => item.maxSeconds > row.maxSeconds).map((item) => item.size).join(" or ") || "512x256"} size.`;
  return null;
}
/** The measured footprint a clip of this size and length is admitted at (the clip's own row), or the largest figure when the size is unknown (never admit less than was measured). */
export function ltx25PeakBytes(width: number, height: number, frames: number): number {
  const row = ltx25Row(width, height);
  if (!row) return LTX25_PEAK_BYTES;
  if (row.size === "512x256" && frames <= 5 * LTX25_FPS + 1) return LTX25_STANDARD_5S_PEAK_BYTES;
  return row.peakBytes;
}

// ---- the managed environment and the installed files ----

export function ltx25RequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  return platform === "darwin" && arch === "arm64" ? darwinArm64Requirements : null;
}
export function ltx25GenRoot(): string { return engineTagRoot(LTX25_GEN_NAME, LTX25_GEN_VERSION); }
export function ltx25GenProof(): string { return join(uvVenvPath(ltx25GenRoot()), "lib", "python3.12", "site-packages", "mlx", "__init__.py"); }
/** The runtime's two source packages (the workspace members the worker imports), on PYTHONPATH. */
export function ltx25SourcePaths(root = ltx25GenRoot()): string[] {
  return [join(root, "packages", "ltx-core-mlx", "src"), join(root, "packages", "ltx-pipelines-mlx", "src")];
}
export function ltx25SourceInstalled(): boolean { return ltx25SourcePaths().every((path) => existsSync(path)); }
export function ltx25EnvironmentReady(): boolean { return ltx25SourceInstalled() && uvEnvironmentReady({ name: LTX25_GEN_NAME, version: LTX25_GEN_VERSION, root: ltx25GenRoot(), proof: ltx25GenProof() }); }
function spec(): UvEnvironmentSpec { return { name: LTX25_GEN_NAME, version: LTX25_GEN_VERSION, root: ltx25GenRoot(), requirements: ltx25RequirementsFileFor(), proof: ltx25GenProof() }; }

/** The pinned runtime source, then the environment on top of it (first time only; a second caller joins the build). */
export async function ensureLtx25Environment(onProgress: (phase: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (!ltx25RequirementsFileFor()) throw new Error(`The LTX-2.5 video engine is not available on ${process.platform} ${process.arch} yet.`);
  const pin = installedEnginePin(LTX25_GEN_NAME);
  if (!pin) throw new Error(`No pinned LTX-2.5 runtime build for ${process.platform} ${process.arch}.`);
  if (!ltx25SourceInstalled() || !existsSync(join(ltx25GenRoot(), ".engine-ready"))) {
    onProgress("source");
    await ensureEngine(pin, () => {}, { signal: options.signal, activate: true });
  }
  await ensureUvEnvironment(spec(), onProgress, options);
}

/** The worker's environment: offline at run time, the runtime packages on PYTHONPATH, no Hugging Face token and no Stack secret. */
export function ltx25WorkerEnv(root = ltx25GenRoot()): Record<string, string> {
  const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: ltx25SourcePaths(root).join(":"), HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1", TQDM_DISABLE: "1", TOKENIZERS_PARALLELISM: "false" });
  delete env.HF_TOKEN; delete env.HUGGING_FACE_HUB_TOKEN;
  return env;
}

/** The installed, verified pack folder, or null when a needed file is missing. The folder holds the text encoder too (the pack bundles Gemma 4). */
export function ltx25ModelPaths(): { modelDir: string } | null {
  const model = getModel(STACK_VIDEO_LTX25_MODEL_ID);
  if (!model?.modelPath || !model.verifiedAt) return null;
  if (!LTX25_REQUIRED_FILES.every((file) => existsSync(join(model.modelPath!, file)))) return null;
  return { modelDir: model.modelPath };
}

/** The worker file (bundled into the daemon); videoGen writes it into the environment root and runs it. */
export { ltx25WorkerScript };

// ---- LTX25-MAX-01: the Max profile, a second runtime and pack ----
//
// Max is 1024x576, 10 s (241 frames at 24 a second), on the official dgrauet/ltx-2-mlx runtime (release 0.18.0, pinned in engineCatalog as
// `ltx25-max-gen`) with the bf16 distilled pack of the ungated mlx-community conversion (modelCatalog, STACK_VIDEO_LTX25_MAX_MODEL). The
// Standard and Boost rows above stay on the fork runtime and the q8 pack. Measured on the M5 Max (128 GB), 2026-11-02: 191 to 272 s,
// OS footprint 48.6 GB (`footprint` and /usr/bin/time -l; the MLX peak reads 37 GB and is NOT the admission number), which passes the
// owner's 64 GB per-clip cap. The runtime MUST be given the pack's Gemma folder: without it the prompt is silently ignored (an unrelated
// clip, garbled speech, about -25 LUFS), so the worker refuses a request that does not name it and the request builder always sets it.
export const LTX25_MAX_GEN_NAME = "ltx25-max-gen";
export const LTX25_MAX_GEN_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === LTX25_MAX_GEN_NAME)?.version ?? "b82b97e";
/** What a request's `model` may say for the Max profile, plus the model record's own id. */
export const LTX25_MAX_MODEL_NAMES = ["ltx25-max", "ltx25-max-bf16"] as const;
export interface Ltx25MaxRow { size: string; width: number; height: number; maxSeconds: number; /** The measured OS footprint of the clip. */ peakBytes: number; profile: "max" }
export const LTX25_MAX_MEASURED: readonly Ltx25MaxRow[] = [
  // 1024x576 is already a multiple of 64 on both sides, so it is made at its nominal size. 10 s (241 frames): 191.5 s (mirror pack) and 272 s (official pack).
  { size: "1024x576", width: 1024, height: 576, maxSeconds: 10, peakBytes: 48.6 * GB, profile: "max" },
];
export const LTX25_MAX_DEFAULT_SIZE = "1024x576";
export const LTX25_MAX_PROFILE_SECONDS = 10;
/** Admission asks for the measured footprint plus 5 percent headroom (the figure is a single measurement on one machine); 51.0 GB, under the 64 GB per-clip cap. */
export const LTX25_MAX_ADMIT_HEADROOM = 1.05;
export const LTX25_MAX_PEAK_BYTES = Math.round(Math.max(...LTX25_MAX_MEASURED.map((row) => row.peakBytes)) * LTX25_MAX_ADMIT_HEADROOM);
/** The per-clip footprint cap the owner set (2026-11-02). */
export const LTX25_CLIP_CAP_BYTES = 64 * GB;
export function ltx25MaxRow(width: number, height: number): Ltx25MaxRow | null {
  const true_ = ltx25TrueSize(width, height);
  return LTX25_MAX_MEASURED.find((row) => row.width === true_.width && row.height === true_.height) ?? null;
}
/** A plain refusal for a size or frame count outside the Max table, or null when the clip is allowed. */
export function ltx25MaxRefusal(width: number, height: number, frames: number): string | null {
  const row = ltx25MaxRow(width, height);
  if (!row) return `The Max video model makes ${LTX25_MAX_MEASURED.map((item) => item.size).join(", ")} only. Pick that size.`;
  if (!Number.isInteger(frames) || frames < 9 || (frames - 1) % 8 !== 0) return "The length must be a whole number of frames that is one more than a multiple of 8 (for example 241 frames, 10 seconds at 24 a second).";
  if (frames > row.maxSeconds * LTX25_FPS + 1) return `A Max clip is at most ${row.maxSeconds} seconds on this computer.`;
  return null;
}
/** The footprint a Max clip is admitted at (always the one measured row, with its headroom; a shorter clip never needs more). */
export function ltx25MaxPeakBytes(): number { return LTX25_MAX_PEAK_BYTES; }

export function ltx25MaxRequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  return platform === "darwin" && arch === "arm64" ? maxDarwinArm64Requirements : null;
}
export function ltx25MaxGenRoot(): string { return engineTagRoot(LTX25_MAX_GEN_NAME, LTX25_MAX_GEN_VERSION); }
/** mlx 0.32.2 is a namespace package (no `__init__.py`), so the proof is the language-model package the pipelines import beside it. */
export function ltx25MaxGenProof(): string { return join(uvVenvPath(ltx25MaxGenRoot()), "lib", "python3.12", "site-packages", "mlx_lm", "__init__.py"); }
export function ltx25MaxSourceInstalled(): boolean { return ltx25SourcePaths(ltx25MaxGenRoot()).every((path) => existsSync(path)); }
export function ltx25MaxEnvironmentReady(): boolean { return ltx25MaxSourceInstalled() && uvEnvironmentReady({ name: LTX25_MAX_GEN_NAME, version: LTX25_MAX_GEN_VERSION, root: ltx25MaxGenRoot(), proof: ltx25MaxGenProof() }); }
function maxSpec(): UvEnvironmentSpec { return { name: LTX25_MAX_GEN_NAME, version: LTX25_MAX_GEN_VERSION, root: ltx25MaxGenRoot(), requirements: ltx25MaxRequirementsFileFor(), proof: ltx25MaxGenProof() }; }

/** The pinned Max runtime source, then the environment on top of it (first time only; a second caller joins the build). */
export async function ensureLtx25MaxEnvironment(onProgress: (phase: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (!ltx25MaxRequirementsFileFor()) throw new Error(`The LTX-2.5 Max video engine is not available on ${process.platform} ${process.arch} yet.`);
  const pin = installedEnginePin(LTX25_MAX_GEN_NAME);
  if (!pin) throw new Error(`No pinned LTX-2.5 Max runtime build for ${process.platform} ${process.arch}.`);
  if (!ltx25MaxSourceInstalled() || !existsSync(join(ltx25MaxGenRoot(), ".engine-ready"))) {
    onProgress("source");
    await ensureEngine(pin, () => {}, { signal: options.signal, activate: true });
  }
  await ensureUvEnvironment(maxSpec(), onProgress, options);
}

/** The installed, verified Max pack folder and its Gemma folder, or null when a needed file is missing. */
export function ltx25MaxModelPaths(): { modelDir: string; gemmaDir: string } | null {
  const model = getModel(STACK_VIDEO_LTX25_MAX_MODEL_ID);
  if (!model?.modelPath || !model.verifiedAt) return null;
  if (!LTX25_MAX_REQUIRED_FILES.every((file) => existsSync(join(model.modelPath!, file)))) return null;
  return { modelDir: model.modelPath, gemmaDir: join(model.modelPath, LTX25_MAX_GEMMA_FOLDER) };
}
