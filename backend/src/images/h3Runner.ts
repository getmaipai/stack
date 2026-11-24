// H3-IMAGE-STACK-01: MiniMax H3-Image, one picture per child process. The h3-image-mlx console script (the h3-image-gen engine,
// images/h3Engine.ts) is started for each picture, writes one PNG and exits, so nothing stays resident between pictures and a
// cancel or a timeout is a kill of the whole process group. The runner stages the text encoder and the DiT in child processes of its
// own, so an in-process MLX peak reads zero: memory is the sampled resident size of the whole process tree.
//
// The DiT runs resident (11 to 15 s, 19.7 GB measured) when the governor admits the resident peak, and streamed from disk (27 to 33 s,
// 1.8 GB) otherwise; never both. The mode is chosen when the job asks the governor for memory (`h3ModeFor`, called from the job's
// memory function) and is the one the runner uses, so the room the governor holds is the room the process takes.
//
// Failures are the picture services' plain shapes (what went wrong, what to do). The child's own words are never kept or shown:
// a traceback can carry a prompt (rule 6a), so they are read only to pick the code.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { heavyGate, PausableProcess } from "@/lib/heavyGate";
import { getGovernorStatus, type GovernorStatus } from "@/lib/governor";
import { getMemoryReader } from "@/lib/memory";
import { registerOwned } from "@/lib/ownedProcesses";
import { logger } from "@/lib/log";
import { TreeSnapshot, treeMemoryBytes } from "@/lib/processTree";
import { managedEnv } from "@/lib/uvEnvironment";
import { ImageError } from "@/images/errors";
import { ensureH3GenEnvironment, h3GenBin, h3GenPython, h3GenRoot } from "@/images/h3Engine";
import { H3_MAX_PICTURES, IMAGE_FAMILIES } from "@/images/models";
import { STACK_IMAGE_H3_ID } from "@/lib/modelCatalog";
import { LARGEST_PROFILE } from "@/lib/profileIds";

export type H3Mode = "resident" | "stream";
export type H3Op = "generate" | "edit";

// ---- the mode, from the grant ----

/** The peak the governor holds for one picture in a mode. */
export function h3PeakBytes(mode: H3Mode, op: H3Op): number {
  const peak = IMAGE_FAMILIES[STACK_IMAGE_H3_ID].peak;
  return mode === "stream" ? peak.stream! : op === "edit" ? peak.edit : peak.gen8;
}

type RoomStatus = Pick<GovernorStatus, "tier" | "capBytes" | "freeMemoryBytes" | "marginBytes" | "loaded">;
/** Resident when this is a 128 GB computer and the governor can hold the resident peak beside what is loaded now, else streaming. A warm picture worker that is only idle counts as free: the governor puts it away to make room. */
export function h3ModeFor(status: RoomStatus, op: H3Op): H3Mode {
  if (status.tier !== LARGEST_PROFILE) return "stream";
  const peak = h3PeakBytes("resident", op);
  const pool = status.loaded.find((item) => item.id === "image-pool")?.peakBytes ?? 0;
  const others = status.loaded.reduce((sum, item) => sum + item.peakBytes, 0) - pool;
  return others + peak <= status.capBytes && status.freeMemoryBytes + pool - peak >= status.marginBytes ? "resident" : "stream";
}

/** The mode each queued job asked the governor for, so the runner takes the one the grant was sized for. */
const grants = new Map<string, H3Mode>();
export function rememberH3Mode(job: string, mode: H3Mode): void {
  grants.set(job, mode);
  while (grants.size > 200) grants.delete(grants.keys().next().value as string);
}
export function takeH3Mode(job: string): H3Mode | null { const mode = grants.get(job) ?? null; grants.delete(job); return mode; }
/** What the job's memory function reads: decides the mode now and remembers it. */
export function decideH3Mode(job: string, op: H3Op, status: RoomStatus = getGovernorStatus()): { mode: H3Mode; peakBytes: number } {
  const mode = h3ModeFor(status, op);
  rememberH3Mode(job, mode);
  return { mode, peakBytes: h3PeakBytes(mode, op) };
}

// ---- the edit prompt ----

/** A caller's plain edit text gets "Using <Picture 1>: " (and <Picture 2> for the second, and so on) in front; text that already names a picture is the caller's own wording and goes through unchanged. */
export function h3EditPrompt(text: string, pictures: number): string {
  if (/<Picture/i.test(text) || pictures < 1) return text;
  const names = Array.from({ length: pictures }, (_, index) => `<Picture ${index + 1}>`);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Using ${list}: ${text}`;
}

// ---- the command ----

export interface H3Picture {
  op: H3Op;
  prompt: string;
  width: number;
  height: number;
  seed: number;
  /** Where the runner writes the PNG. */
  output: string;
  /** Where the runner writes its metrics file. */
  metrics: string;
  /** The input pictures of an edit, the one being changed first; at most 16. */
  pictures: string[];
  mode: H3Mode;
  modelsDir: string;
}

/** The exact command line for one picture. */
export function h3Command(bin: string, picture: H3Picture): string[] {
  if (picture.pictures.length > H3_MAX_PICTURES) throw new ImageError("bad_request", `MiniMax H3-Image takes at most ${H3_MAX_PICTURES} pictures in one edit.`, 422);
  return [
    bin, "generate", "--models", picture.modelsDir, "--model", "h3", "--precision", "int8", "--dit-mode", picture.mode,
    "--seed", String(picture.seed), "--width", String(picture.width), "--height", String(picture.height),
    // argparse would read a prompt that starts with a dash as a flag; the joined form is always a value.
    ...(picture.prompt.startsWith("-") ? [`--prompt=${picture.prompt}`] : ["--prompt", picture.prompt]),
    "--output", picture.output, "--metrics", picture.metrics,
    ...picture.pictures.flatMap((path) => ["--reference", path]),
  ];
}

/** Re-saves the picture with no EXIF, profile or generation parameters and writes the 384 px thumbnail (the same finish the mflux worker gives its pictures). */
export const H3_FINISH_SCRIPT = [
  "import sys",
  "from PIL import Image",
  "raw, png, thumb = sys.argv[1:4]",
  "image = Image.open(raw).convert('RGB')",
  "clean = Image.new('RGB', image.size)",
  "clean.paste(image)",
  "clean.save(png, 'PNG')",
  "small = clean.copy()",
  "small.thumbnail((384, 384), Image.LANCZOS)",
  "small.save(thumb, 'JPEG', quality=84)",
].join("\n");
export const h3FinishCommand = (python: string, raw: string, png: string, thumb: string): string[] => [python, "-I", "-c", H3_FINISH_SCRIPT, raw, png, thumb];

/** The seconds a picture took, if the runner's metrics file says (it may be empty: 0.1.0a8 writes `{}` for H3); the caller falls back to its own clock. */
export function h3MetricsSeconds(text: string): number | null {
  try {
    const metrics = JSON.parse(text) as Record<string, unknown>;
    for (const key of ["wall_seconds", "total_seconds", "elapsed_seconds", "seconds", "wall_s", "total_s"]) {
      const value = metrics[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
  } catch { /* no metrics */ }
  return null;
}

// ---- the process ----

export interface H3Child {
  pid: number;
  exited: Promise<number>;
  /** What the process wrote to its error stream, read after it exits and used only to pick a failure code. */
  stderr: () => Promise<string>;
}
export interface H3Deps {
  ensureEnvironment: (onProgress: (phase: string) => void, signal?: AbortSignal) => Promise<void>;
  bin: () => string;
  python: () => string;
  /** A scratch folder for the pictures' raw files and metrics. */
  scratch: () => string;
  /** Starts a process in a group of its own, so the whole tree can be stopped with one signal. */
  spawn: (command: string[], options: { cwd: string; env: Record<string, string> }) => H3Child;
  killGroup: (pid: number, signal: NodeJS.Signals) => void;
  /** The resident size of the process and everything it started, now; null when it cannot be read. */
  sampleBytes: (pid: number) => number | null;
  /** Tells the Stack which processes it owns, and stops tracking when the run ends. */
  track: (pid: number) => { finished(): void };
  /** The seconds the process may run per picture. */
  deadlineMs: (picture: H3Picture) => number;
  graceMs: number;
  /** How often memory is sampled and progress is reported while a picture runs. */
  tickMs: number;
}

const STDERR_LIMIT = 65_536;
export const defaultH3Deps: H3Deps = {
  ensureEnvironment: (onProgress, signal) => ensureH3GenEnvironment(onProgress, { signal }),
  bin: () => process.env.H3_IMAGE_GEN_BIN ?? h3GenBin(),
  python: () => process.env.H3_IMAGE_GEN_PYTHON ?? h3GenPython(),
  scratch: () => join(h3GenRoot(), "run"),
  spawn: (command, options) => {
    const child = Bun.spawn(command, { cwd: options.cwd, env: options.env, stdin: "ignore", stdout: "ignore", stderr: "pipe", detached: true });
    let text: Promise<string> | null = null;
    return { pid: child.pid, exited: child.exited, stderr: () => text ??= (async () => { let out = ""; for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) { if (out.length < STDERR_LIMIT) out += new TextDecoder().decode(chunk); } return out; })().catch(() => "") };
  },
  killGroup: (pid, signal) => { try { process.kill(-pid, signal); } catch { /* gone */ } },
  sampleBytes: (pid) => treeMemoryBytes(pid, (member) => getMemoryReader().processMemoryBytes(member)),
  track: (pid) => { const owned = registerOwned("image-h3", new TreeSnapshot(pid)); return { finished: () => owned.finished() }; },
  deadlineMs: () => Number(process.env.H3_IMAGE_DEADLINE_MS ?? 4 * 60_000),
  graceMs: 2_000,
  tickMs: 1_000,
};

/** The child's environment: offline, no Hugging Face token, every cache under data/. */
export function h3Env(): Record<string, string> {
  const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1", TQDM_DISABLE: "1", TOKENIZERS_PARALLELISM: "false" });
  delete env.HF_TOKEN; delete env.HUGGING_FACE_HUB_TOKEN;
  return env;
}

export interface H3Run {
  op: H3Op;
  prompt: string;
  width: number;
  height: number;
  seed: number;
  count: number;
  /** The edit's input pictures (the one being changed first), as files. */
  pictures: string[];
  outDir: string;
  modelsDir: string;
  mode: H3Mode;
}
export interface H3Options {
  signal?: AbortSignal;
  jobId: string;
  onPhase?: (phase: string, phasePercent: number) => void;
  onImage?: (index: number) => void;
}
export interface H3Result { seeds: number[]; ms: number; peakBytes: number | null; mode: H3Mode; }

/** A failure as a plain sentence. The child's output picks the code and is never shown. */
export function h3Failure(exitCode: number, stderr: string): ImageError {
  const killed = exitCode === 137 || exitCode === 9 || exitCode === -9 || /out of memory|MemoryError|insufficient memory|kIOGPU|failed to allocate/i.test(stderr);
  if (killed) return new ImageError("out_of_memory", "MiniMax H3-Image ran out of memory and was stopped. Close other big jobs, or try again in a few minutes.", 507);
  if (/no such file|not found|missing|checksum|hash/i.test(stderr)) return new ImageError("model_missing", "MiniMax H3-Image's files are missing or damaged. Install it again from Home's Engines page, then try again.", 503);
  return new ImageError("failed", "MiniMax H3-Image could not make the picture. Try again; if it keeps failing, an admin can reinstall it from Home's Engines page.", 500);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `count` pictures one after another, one process each, and leaves `<n>.png` and `<n>.thumb.jpg` in `outDir`. */
export async function runH3(run: H3Run, options: H3Options, deps: H3Deps = defaultH3Deps): Promise<H3Result> {
  if (options.signal?.aborted) throw new ImageError("cancelled", "Cancelled.", 499);
  options.onPhase?.("setting up", 0);
  try { await deps.ensureEnvironment(() => options.onPhase?.("setting up", 0), options.signal); } catch (error) {
    if (options.signal?.aborted) throw new ImageError("cancelled", "Cancelled.", 499);
    throw new ImageError("setup_failed", `The picture engine could not be set up: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, "")}. Check this computer's internet connection and try again.`, 503);
  }
  const scratch = join(deps.scratch(), options.jobId);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  mkdirSync(run.outDir, { recursive: true, mode: 0o700 });
  const seeds: number[] = [];
  let peak = 0;
  let ms = 0;
  try {
    for (let index = 0; index < run.count; index += 1) {
      const seed = run.seed + index;
      const raw = join(scratch, `${index}.raw.png`);
      const picture: H3Picture = { op: run.op, prompt: run.prompt, width: run.width, height: run.height, seed, output: raw, metrics: join(scratch, `${index}.metrics.json`), pictures: run.pictures, mode: run.mode, modelsDir: run.modelsDir };
      const t0 = Date.now();
      peak = Math.max(peak, await runOne(picture, options, deps, index, run.count));
      // The runner's own seconds when its metrics file has them; otherwise this process's clock.
      ms += Math.round((readH3Seconds(picture.metrics) ?? (Date.now() - t0) / 1000) * 1000);
      const finish = deps.spawn(h3FinishCommand(deps.python(), raw, join(run.outDir, `${index}.png`), join(run.outDir, `${index}.thumb.jpg`)), { cwd: scratch, env: h3Env() });
      const code = await finish.exited;
      if (code !== 0) { void finish.stderr(); throw new ImageError("failed", "The picture was made but could not be saved. Try again.", 500); }
      seeds.push(seed);
      options.onImage?.(index);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  options.onPhase?.("decoding", 100);
  return { seeds, ms, peakBytes: peak > 0 ? peak : null, mode: run.mode };
}

/** One picture: start the process, watch it (memory, progress, cancel, deadline), and say how it ended. Returns the peak sampled size of the process tree. */
async function runOne(picture: H3Picture, options: H3Options, deps: H3Deps, index: number, count: number): Promise<number> {
  const command = h3Command(deps.bin(), picture);
  const began = Date.now();
  const child = deps.spawn(command, { cwd: join(picture.output, ".."), env: h3Env() });
  const owned = deps.track(child.pid);
  const pausable = new PausableProcess(child.pid, child.exited, { tree: true });
  const lease = heavyGate.attach({ role: "image", jobId: options.jobId, worker: pausable });
  const expected = IMAGE_FAMILIES[STACK_IMAGE_H3_ID].warmSeconds * (picture.mode === "stream" ? 2.3 : 1) * (picture.op === "edit" ? 3 : 1) * 1000;
  let peak = 0;
  const state: { outcome: "exit" | "cancelled" | "timeout" } = { outcome: "exit" };
  let stopping: Promise<void> | null = null;
  // Stops the whole group: ask, wait out the grace, then force. The process runs again first, so a stopped one takes the signal.
  const stop = (why: "cancelled" | "timeout"): Promise<void> => stopping ??= (async () => {
    state.outcome = why;
    pausable.resume();
    deps.killGroup(child.pid, "SIGTERM");
    const ended = await Promise.race([child.exited.then(() => true), sleep(deps.graceMs).then(() => false)]);
    deps.killGroup(child.pid, "SIGKILL");
    if (!ended) await Promise.race([child.exited, sleep(deps.graceMs)]);
  })();
  const onAbort = () => { void stop("cancelled"); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const deadline = pausable.deadline(deps.deadlineMs(picture), () => { void stop("timeout"); });
  const sample = () => { const bytes = deps.sampleBytes(child.pid); if (bytes !== null && bytes > peak) peak = bytes; };
  const tick = setInterval(() => {
    sample();
    const share = Math.min(0.95, (Date.now() - began) / expected);
    options.onPhase?.("rendering", Math.round(((index + share) / count) * 100));
  }, deps.tickMs);
  options.onPhase?.("loading", Math.round((index / count) * 100));
  sample();
  let exitCode: number;
  try { exitCode = await child.exited; } finally { clearInterval(tick); deadline.clear(); options.signal?.removeEventListener("abort", onAbort); lease.detach(); owned.finished(); }
  sample();
  if (stopping) await stopping;
  if (state.outcome === "cancelled") throw new ImageError("cancelled", "Cancelled.", 499);
  if (state.outcome === "timeout") throw new ImageError("timeout", "The picture took too long and was stopped. Try again, or ask for a smaller picture.", 504);
  const stderr = exitCode === 0 ? "" : await child.stderr().catch(() => "");
  if (exitCode !== 0) {
    // One diagnosis line, no words from the process: the family, the mode and the exit code.
    logger.appendLine(JSON.stringify({ event: "image.h3_failed", family: STACK_IMAGE_H3_ID, op: picture.op, mode: picture.mode, exit: exitCode }));
    throw h3Failure(exitCode, stderr);
  }
  return peak;
}

/** Reads the metrics file's seconds, or null. */
function readH3Seconds(path: string): number | null { try { return h3MetricsSeconds(readFileSync(path, "utf8")); } catch { return null; } }
