// One builder for every Python environment the Stack assembles: the
// pinned uv build (an engine archive, checksummed), a venv on a managed
// Python, a committed requirements file with hashes synced into it, a
// ready marker written last. Pocket TTS (STACK-94c) and ComfyUI
// (STACK-13b) both build this way; a platform with no requirements
// file yet cannot build and says so. Every cache and HOME the tools
// touch lives under data/, and the daemon's own secrets never travel.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_READY_MARKER, installedEnginePin } from "@/lib/engineCatalog";
import { engineBinaryPath, ensureEngine } from "@/lib/engineInstall";
import { dataDir } from "@/lib/paths";
import { hfHubRoot } from "@/lib/store/layout";
import { readEngineManifest, writeEngineManifest } from "@/lib/store/manifests";
import { bumpStackGeneration } from "@/lib/stackGeneration";

export const MANAGED_PYTHON = "3.12";
/** The environment's own ready marker, distinct from an engine
 * archive's `.engine-ready` in the same directory (ComfyUI's source
 * lands there first): a source that extracted is not an environment
 * that built. */
export const ENV_READY_MARKER = ".env-ready";

export interface UvEnvironmentSpec {
  /** The engine name (`pocket-tts`, `comfyui`) and version: the venv lives under data/engines/<name>/<version>/venv. */
  name: string;
  version: string;
  root: string;
  /** The hashed requirements file for this platform, or null when none exists yet. */
  requirements: string | null;
  /** A file that proves the environment can serve (the console script, the entry file). */
  proof: string;
}

export function uvVenvPath(root: string): string { return join(root, "venv"); }
export function uvVenvPython(root: string): string { return join(uvVenvPath(root), "bin", "python"); }
export function uvEnvironmentReady(spec: Pick<UvEnvironmentSpec, "root" | "proof"> & Partial<Pick<UvEnvironmentSpec, "name" | "version">>): boolean {
  if (existsSync(join(spec.root, ENV_READY_MARKER)) && existsSync(spec.proof)) return true;
  // Before STACK-13b an environment with no source archive (Pocket TTS)
  // wrote the engine marker for itself; such a root, whose manifest
  // names its requirements file and no archive, is renamed once.
  if (spec.name && spec.version && existsSync(spec.proof) && existsSync(join(spec.root, ENGINE_READY_MARKER))) {
    const manifest = readEngineManifest(spec.name, spec.version);
    if (manifest?.assetUrl.startsWith("requirements:")) { renameSync(join(spec.root, ENGINE_READY_MARKER), join(spec.root, ENV_READY_MARKER)); return true; }
  }
  return false;
}

/** uv's own homes and the caches a Python tool writes, all under data/:
 * the managed interpreter, the wheel cache, HOME (so nothing lands in
 * the person's account), the hub cache. The daemon's secrets key stays
 * with the daemon; only what `extra` names goes. */
export function managedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const inherited = { ...process.env as Record<string, string> };
  for (const key of Object.keys(inherited)) if (key === "STACK_SECRETS_KEY" || key.startsWith("MAIPAI_SECRETS")) delete inherited[key];
  return {
    ...inherited,
    HOME: join(dataDir, "home"),
    UV_PYTHON_INSTALL_DIR: join(dataDir, "engines", "uv", "python"),
    UV_CACHE_DIR: join(dataDir, "engines", "uv", "cache"),
    HF_HUB_CACHE: hfHubRoot,
    HF_HUB_DISABLE_TELEMETRY: "1",
    ...extra,
  };
}

async function run(command: string[], env: Record<string, string>, signal?: AbortSignal): Promise<void> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", env });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  signal?.removeEventListener("abort", abort);
  if (signal?.aborted) throw new Error("The environment build was cancelled.");
  if (code !== 0) throw new Error(`${command.slice(0, 3).join(" ")} exited ${code}: ${(err || out).trim().split("\n").slice(-5).join(" | ")}`);
}

const building = new Map<string, Promise<void>>();

/** Builds an environment once; a second caller during the build waits
 * on the same promise, so two installs never race on one venv.
 * Progress is by phase (uv, python, packages): uv reports no byte
 * counts a job could show. */
export function ensureUvEnvironment(spec: UvEnvironmentSpec, onProgress: (phase: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (uvEnvironmentReady(spec)) return Promise.resolve();
  let inFlight = building.get(spec.name);
  if (!inFlight) {
    inFlight = buildUvEnvironment(spec, onProgress, options).finally(() => { building.delete(spec.name); });
    building.set(spec.name, inFlight);
  }
  return inFlight;
}

/** The macOS the hashed requirements were compiled for: torch 2.13
 * ships macOS 14 wheels only, so an older Mac is refused with the
 * reason before uv fails on a platform tag. */
export const MACOS_FLOOR = 14;
function macosMajor(): number | null {
  if (process.platform !== "darwin") return null;
  const major = Number(String(Bun.spawnSync(["sw_vers", "-productVersion"]).stdout).trim().split(".")[0]);
  return Number.isFinite(major) ? major : null;
}

async function buildUvEnvironment(spec: UvEnvironmentSpec, onProgress: (phase: string) => void, options: { signal?: AbortSignal }): Promise<void> {
  if (!spec.requirements) throw new Error(`No hashed requirements file for ${process.platform} ${process.arch} yet; the ${spec.name} environment cannot be built on this machine.`);
  const macos = macosMajor();
  if (macos !== null && macos < MACOS_FLOOR) throw new Error(`The ${spec.name} environment needs macOS ${MACOS_FLOOR} or later (this Mac runs ${macos}); torch 2.13 ships wheels for macOS 14 only.`);
  const uvPin = installedEnginePin("uv");
  if (!uvPin) throw new Error(`No pinned uv build for ${process.platform} ${process.arch}.`);
  onProgress("uv");
  await ensureEngine(uvPin, () => {}, { signal: options.signal, activate: true });
  const uv = engineBinaryPath(uvPin);
  const venv = uvVenvPath(spec.root);
  rmSync(venv, { recursive: true, force: true });
  mkdirSync(spec.root, { recursive: true });
  const env = managedEnv();
  onProgress("python");
  await run([uv, "venv", venv, "--python", MANAGED_PYTHON], env, options.signal);
  onProgress("packages");
  await run([uv, "pip", "sync", "--python", uvVenvPython(spec.root), "--require-hashes", spec.requirements], env, options.signal);
  if (!existsSync(spec.proof)) throw new Error(`The ${spec.name} environment built but ${spec.proof.split("/").pop()} is not in it.`);
  writeFileSync(join(spec.root, ENV_READY_MARKER), new Date().toISOString());
  // An engine whose archive wrote the manifest keeps it; an environment
  // with no archive (Pocket TTS) records its requirements file.
  if (!readEngineManifest(spec.name, spec.version)) writeEngineManifest({ kind: "engine", name: spec.name, tag: spec.version, assetUrl: `requirements:${spec.requirements.split("/").pop()}`, sizeBytes: 0, githubDigest: "", sha256: "", extractedAt: new Date().toISOString(), blobs: [] });
  bumpStackGeneration(`engine ${spec.name} environment built at ${spec.version}`);
}
